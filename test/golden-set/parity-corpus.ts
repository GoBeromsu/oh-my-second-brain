/**
 * Corpus digest for a real-vault parity run.
 *
 * `parity-preregistration.ts` requires a `corpusDigest`, and AC-21 makes any
 * mutation of the corpus invalidate the run — but nothing computed one, so the
 * field could only ever have been filled in by hand. A required piece of evidence
 * with no producer is not evidence; this module produces it.
 *
 * What the digest has to survive is the specific way a benchmark quietly stops
 * being reproducible: the vault is a living set of notes, so between a run and its
 * re-run a note gets edited, renamed, added, or removed, and the numbers move for
 * reasons that have nothing to do with the engine. The digest therefore covers
 * both *which* documents exist and *what* is in them, and it is order-independent
 * so two machines walking the filesystem differently still agree.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Directories excluded from the corpus.
 *
 * These hold derived or tool-owned state, not notes. `.oms` in particular
 * contains the engine store the run itself writes, so including it would make the
 * digest depend on the measurement — the corpus would change simply by being
 * measured, and no run could ever reproduce another.
 */
export const EXCLUDED_DIRECTORIES: readonly string[] = [
  ".git",
  ".oms",
  ".obsidian",
  ".trash",
  "node_modules",
];

function isExcludedDirectory(name: string): boolean {
  // qmd's collection glob does not traverse dot-directories. Keep the named list
  // above as the auditable documentation of known tool state, and apply the same
  // general rule so newly introduced `.gjc`/`.claude`/`.codex` state cannot enter
  // either the benchmark digest or OMS search results.
  return name.startsWith(".") || EXCLUDED_DIRECTORIES.includes(name);
}

/** The corpus is the markdown notes; other files are attachments or tooling. */
export const CORPUS_EXTENSION = ".md" as const;

export interface CorpusEntry {
  /** Vault-relative path, POSIX-separated so the digest is platform-stable. */
  readonly relativePath: string;
  /** SHA-256 of the file's exact bytes. */
  readonly contentSha256: string;
}

export interface CorpusSnapshot {
  readonly digest: string;
  readonly fileCount: number;
  readonly entries: readonly CorpusEntry[];
}

/** Injectable filesystem, so the contract is testable without a 21k-file vault. */
export interface CorpusFs {
  readonly listDirectory: (directory: string) => Promise<readonly {
    readonly name: string;
    readonly isDirectory: boolean;
    readonly isFile: boolean;
  }[]>;
  readonly readFileBytes: (file: string) => Promise<Uint8Array>;
}

const nodeFs: CorpusFs = {
  listDirectory: async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }));
  },
  readFileBytes: async (file) => readFile(file),
};

function sha256(input: Uint8Array | string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Canonical serialization of a corpus.
 *
 * Sorted by path, one `path\0digest` row per file, rows joined by newline. Sorting
 * is what makes the digest independent of directory iteration order.
 *
 * The comparison is deliberately by UTF-16 code unit, **not** `localeCompare`.
 * `localeCompare` resolves against the runtime's default locale and ICU build, so
 * two machines could order the same filenames differently and derive different
 * digests from an identical vault — which is precisely the reproducibility failure
 * this digest exists to detect. This matches `canonicalQrels`, which relies on
 * plain `Array.prototype.sort` for the same reason.
 *
 * The encoding is injective. Paths cannot contain NUL (POSIX forbids it) and every
 * digest is exactly 64 hex characters, so the NUL positions and fixed digest width
 * pin every row boundary. A filename containing a newline therefore cannot shift a
 * boundary and collide with a different corpus.
 */
export function canonicalCorpus(entries: readonly CorpusEntry[]): string {
  return [...entries]
    .sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0))
    .map((entry) => `${entry.relativePath}\u0000${entry.contentSha256}`)
    .join("\n");
}

const CONTENT_DIGEST = /^[a-f0-9]{64}$/;

/**
 * Digest a set of already-collected entries.
 *
 * The entry shape is validated rather than assumed, because {@link canonicalCorpus}
 * derives its injectivity from exactly these two properties: paths contain no NUL,
 * and every content digest is exactly 64 hex characters. `snapshotCorpus` always
 * satisfies them, but this function is exported and would otherwise let a
 * hand-built entry silently violate the encoding guarantee its own contract claims.
 */
export function corpusDigest(entries: readonly CorpusEntry[]): string {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.relativePath !== "string" || entry.relativePath === "") {
      throw new Error("corpus entry relativePath must be a non-empty string");
    }
    if (entry.relativePath.includes("\u0000")) {
      throw new Error(`corpus entry path must not contain NUL: ${JSON.stringify(entry.relativePath)}`);
    }
    if (typeof entry.contentSha256 !== "string" || !CONTENT_DIGEST.test(entry.contentSha256)) {
      throw new Error(
        `corpus entry ${entry.relativePath} must carry a lowercase 64-character sha256 digest`,
      );
    }
    if (seen.has(entry.relativePath)) {
      throw new Error(`corpus contains a duplicate path: ${entry.relativePath}`);
    }
    seen.add(entry.relativePath);
  }
  return sha256(canonicalCorpus(entries));
}

/**
 * Walk a vault and produce its snapshot.
 *
 * Symlinks are not followed: a link out of the vault would make the digest depend
 * on files the vault does not own, and a link cycle would not terminate. `dirent`
 * reports a symlink as neither a regular file nor a directory, so they are skipped
 * by construction rather than by a special case.
 */
export async function snapshotCorpus(
  vaultPath: string,
  fs: CorpusFs = nodeFs,
): Promise<CorpusSnapshot> {
  const entries: CorpusEntry[] = [];

  const walk = async (absolute: string, relative: string): Promise<void> => {
    for (const entry of await fs.listDirectory(absolute)) {
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory) {
        if (isExcludedDirectory(entry.name)) continue;
        await walk(childAbsolute, childRelative);
        continue;
      }
      if (!entry.isFile) continue;
      if (!entry.name.toLowerCase().endsWith(CORPUS_EXTENSION)) continue;
      entries.push({
        relativePath: childRelative,
        contentSha256: sha256(await fs.readFileBytes(childAbsolute)),
      });
    }
  };

  await walk(vaultPath, "");
  return { digest: corpusDigest(entries), fileCount: entries.length, entries };
}

/**
 * Confirm a vault still matches a previously declared digest.
 *
 * Returns the reason rather than a bare boolean, because "the corpus moved" is
 * only actionable if the operator is told how: the file count difference usually
 * distinguishes an edit from an added or deleted note.
 */
export async function verifyCorpusDigest(
  vaultPath: string,
  expectedDigest: string,
  fs: CorpusFs = nodeFs,
): Promise<{ readonly ok: boolean; readonly actual: string; readonly reason?: string }> {
  const normalized = expectedDigest.replace(/^sha256:/iu, "").toLowerCase();
  const snapshot = await snapshotCorpus(vaultPath, fs);
  if (snapshot.digest === normalized) return { ok: true, actual: snapshot.digest };
  return {
    ok: false,
    actual: snapshot.digest,
    reason:
      `corpus digest mismatch: expected ${normalized}, measured ${snapshot.digest} ` +
      `over ${snapshot.fileCount} files. The vault changed since preregistration, so this run ` +
      "is not comparable; re-preregister against the current corpus.",
  };
}
