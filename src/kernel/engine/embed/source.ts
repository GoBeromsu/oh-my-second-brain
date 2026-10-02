import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileMetadataWitness, readFileSnapshot } from "../../conventions/file-snapshot.js";
import type Database from "better-sqlite3";
import type { Chunk, ChunkerOptions } from "../types.js";

/** Filesystem change evidence, not a cryptographic claim about unchanged bytes. */
export interface DocumentSource {
  readonly fingerprint: string | null;
  readonly contentSha256: string;
  readonly chunker: string;
}

export const DOCUMENT_SOURCE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS engine_document_source (
    doc_path TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    fingerprint TEXT,
    content_sha256 TEXT NOT NULL,
    chunker TEXT NOT NULL
  );
`;

interface SourceRow {
  doc_path: string;
  version: number;
  fingerprint: string | null;
  content_sha256: string;
  chunker: string;
}
const DIGEST = /^[a-f0-9]{64}$/u;

function decodeSource(row: SourceRow): DocumentSource {
  if (row.version !== 1 || (row.fingerprint !== null && !DIGEST.test(row.fingerprint)) || !DIGEST.test(row.content_sha256) || typeof row.chunker !== "string" || row.chunker.length === 0) {
    throw new Error("Engine document source evidence is invalid or unsupported. Run an explicit index synchronization.");
  }
  return { fingerprint: row.fingerprint, contentSha256: row.content_sha256, chunker: row.chunker };
}

export function createDocumentSourceAccess(db: Database.Database, readonly = false) {
  const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'engine_document_source'").get() !== undefined;
  const read = present ? db.prepare<[], SourceRow>("SELECT doc_path, version, fingerprint, content_sha256, chunker FROM engine_document_source") : null;
  const readOne = present ? db.prepare<[string], SourceRow>("SELECT doc_path, version, fingerprint, content_sha256, chunker FROM engine_document_source WHERE doc_path = ?") : null;
  const remove = !readonly && present ? db.prepare<[string]>("DELETE FROM engine_document_source WHERE doc_path = ?") : null;
  const insert = !readonly && present ? db.prepare<[string, string | null, string, string]>(
    "INSERT OR REPLACE INTO engine_document_source (doc_path, version, fingerprint, content_sha256, chunker) VALUES (?, 1, ?, ?, ?)",
  ) : null;
  const chunks = !readonly ? db.prepare<[string], { ordinal: number; sha: string }>("SELECT ordinal, sha FROM engine_chunk_meta WHERE doc_path = ? ORDER BY ordinal") : null;
  const record = db.transaction((docPath: string, source: DocumentSource, expected: ReadonlyArray<Pick<Chunk, "ordinal" | "sha">>) => {
    if (insert === null || chunks === null) throw new Error("EngineStore: recordDocumentSource is unavailable because this store was opened for reading only.");
    if ((source.fingerprint !== null && !DIGEST.test(source.fingerprint)) || !DIGEST.test(source.contentSha256) || source.chunker.length === 0) throw new Error("Engine document source evidence is invalid.");
    const actual = chunks.all(docPath);
    const byOrdinal = new Map(expected.map(chunk => [chunk.ordinal, chunk.sha]));
    if (actual.length !== expected.length || actual.some(chunk => byOrdinal.get(chunk.ordinal) !== chunk.sha)) {
      throw new Error("Engine document chunks changed before source evidence could be published. Retry synchronization.");
    }
    insert.run(docPath, source.fingerprint, source.contentSha256, source.chunker);
  });
  return {
    invalidate(docPath: string): void { remove?.run(docPath); },
    readDocumentSources(): Map<string, DocumentSource> | null {
      if (read === null) return null;
      return new Map(read.all().map(row => [row.doc_path, decodeSource(row)]));
    },
    readDocumentSource(docPath: string): DocumentSource | null {
      const row = readOne?.get(docPath);
      return row === undefined ? null : decodeSource(row);
    },
    recordDocumentSource(docPath: string, source: DocumentSource, expected: ReadonlyArray<Pick<Chunk, "ordinal" | "sha">>): void {
      record(docPath, source, expected);
    },
  };
}

/** Exact bigint metadata also detects atomic replacement and restored mtime edits. */
export async function documentSourceFingerprint(vault: string, docPath: string, canonicalRoot?: string): Promise<string | null> {
  const root = canonicalRoot ?? await realpath(vault);
  const filename = path.resolve(vault, docPath);
  const target = await realpath(filename);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Indexed document source escapes the configured vault.");
  }
  const info = await stat(filename, { bigint: true });
  if (!info.isFile()) throw new Error("Indexed document source is not a regular file.");
  const witness = fileMetadataWitness(info);
  return witness === null ? null : sourceFingerprint(root, docPath, target, witness);
}

function sourceFingerprint(root: string, docPath: string, target: string, witness: string): string {
  return createHash("sha256").update(JSON.stringify([root, docPath, target, witness])).digest("hex");
}

/** Capture the identity before and after the exact bytes used by the chunker. */
export async function readDocumentSource(vault: string, docPath: string, options?: Partial<ChunkerOptions>): Promise<{ readonly content: string; readonly source: DocumentSource }> {
  // Whole-vault lexical enumeration never follows symlinks. Explicit file
  // slices must not introduce a source that the next freshness scan ignores.
  let cursor = path.resolve(vault);
  for (const segment of docPath.split(/[\\/]/u)) {
    cursor = path.resolve(cursor, segment);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Indexed document sources must not traverse symbolic links.");
  }
  const root = await realpath(vault);
  const filename = path.resolve(vault, docPath);
  const target = await realpath(filename);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Indexed document source escapes the configured vault.");
  const expected = await stat(filename, { bigint: true });
  const captured = await readFileSnapshot(filename, expected);
  if (await realpath(filename) !== target) throw new Error("Indexed document source changed while being read. Retry synchronization.");
  const { bytes, witness } = captured;
  return {
    content: bytes.toString("utf8"),
    source: {
      fingerprint: witness === null ? null : sourceFingerprint(root, docPath, target, witness),
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      chunker: JSON.stringify({ version: 1, maxTokens: options?.maxTokens ?? 900, overlapRatio: options?.overlapRatio ?? 0.15 }),
    },
  };
}

/** Synchronous commit-time witness. Markdown and SQLite are not one transaction. */
export function documentSourceMatches(vault: string, docPath: string, source: DocumentSource): boolean {
  const root = realpathSync(vault);
  try {
    let cursor = path.resolve(vault);
    for (const segment of docPath.split(/[\\/]/u)) {
      cursor = path.resolve(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink()) return false;
    }
    const filename = path.resolve(vault, docPath);
    const target = realpathSync(filename);
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    const info = statSync(filename, { bigint: true });
    if (!info.isFile()) return false;
    const witness = fileMetadataWitness(info);
    if (source.fingerprint !== null && witness !== null) return source.fingerprint === sourceFingerprint(root, docPath, target, witness);
    // Weak witnesses use exact bytes bound to a regular open handle. NONBLOCK
    // prevents a substituted FIFO from hanging the short writer transaction.
    const handle = openSync(filename, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const before = fstatSync(handle, { bigint: true });
      if (!before.isFile()) return false;
      const bytes = readFileSync(handle);
      const after = fstatSync(handle, { bigint: true });
      const latest = statSync(filename, { bigint: true });
      const fields = ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const;
      if ([before, after, latest].some(info => !info.isFile() || fields.some(field => info[field] !== before[field])) ||
        fields.some(field => info[field] !== before[field]) || BigInt(bytes.length) !== before.size || realpathSync(filename) !== target) return false;
      return source.contentSha256 === createHash("sha256").update(bytes).digest("hex");
    } finally { closeSync(handle); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** A missing vault, access error, or symlink is not evidence of a deleted note. */
export function documentSourceMissing(vault: string, docPath: string): boolean {
  realpathSync(vault);
  let cursor = path.resolve(vault);
  for (const segment of docPath.split(/[\\/]/u)) {
    cursor = path.resolve(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error("Indexed document sources must not traverse symbolic links.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }
  return false;
}
