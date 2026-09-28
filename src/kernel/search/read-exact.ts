import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { nfcEquals, toNfc } from "../text/nfc.js";

/**
 * Engine-free exact read of one vault note by its vault-relative path.
 *
 * This path never opens an engine store, a database, or a model: it is plain
 * filesystem I/O, so a single-note read costs only process startup plus one
 * directory walk. `test/architecture/read-exact-isolation.test.ts` keeps it so.
 *
 * Lookup is normalization-insensitive. Each path segment is matched against the
 * directory listing, preferring the caller's exact spelling, then its NFC
 * spelling, then any single entry that is NFC-equal. That makes an NFC request find an NFD file on
 * every filesystem, not only on macOS where APFS happens to resolve it.
 */

export interface ReadExactResult {
  /** Vault-relative POSIX path, spelled as it is on disk. */
  readonly path: string;
  readonly content: string;
  /** `sha256:` followed by the hex digest of the file bytes. */
  readonly revision: string;
}

export type ReadExactErrorCode =
  | "READ_EXACT_INVALID_PATH"
  | "READ_EXACT_NOT_FOUND"
  | "READ_EXACT_AMBIGUOUS"
  | "READ_EXACT_ESCAPE"
  | "READ_EXACT_NOT_FILE";

export class ReadExactError extends Error {
  constructor(readonly code: ReadExactErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ReadExactError";
  }
}

function isWindowsAbsolute(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** Splits a vault-relative path into segments, refusing anything that could leave the vault. */
function segmentsOf(relPath: string): string[] {
  if (relPath.trim().length === 0) throw new ReadExactError("READ_EXACT_INVALID_PATH", "path must not be empty");
  if (relPath.includes("\0")) throw new ReadExactError("READ_EXACT_INVALID_PATH", "path must not contain NUL");
  if (path.isAbsolute(relPath) || relPath.startsWith("/") || isWindowsAbsolute(relPath)) {
    throw new ReadExactError("READ_EXACT_INVALID_PATH", `path must be vault-relative, got ${JSON.stringify(relPath)}`);
  }
  if (/[\\/]$/.test(relPath)) {
    throw new ReadExactError("READ_EXACT_INVALID_PATH", `path must name a file, not end in a separator, got ${JSON.stringify(relPath)}`);
  }
  const segments = relPath.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.includes("..")) {
    throw new ReadExactError("READ_EXACT_INVALID_PATH", `path must not contain "..", got ${JSON.stringify(relPath)}`);
  }
  if (segments.length === 0) throw new ReadExactError("READ_EXACT_INVALID_PATH", "path must name a file");
  return segments;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function notFound(relPath: string): ReadExactError {
  return new ReadExactError("READ_EXACT_NOT_FOUND", `no note at ${JSON.stringify(relPath)} in the vault`);
}

/** Picks the on-disk entry for one requested segment, or undefined when none matches. */
export function matchEntry(entries: readonly string[], segment: string, relPath: string): string | undefined {
  if (entries.includes(segment)) return segment;
  const composed = toNfc(segment);
  if (entries.includes(composed)) return composed;
  const candidates = entries.filter((entry) => nfcEquals(entry, segment));
  if (candidates.length > 1) {
    throw new ReadExactError(
      "READ_EXACT_AMBIGUOUS",
      `${JSON.stringify(relPath)} matches ${candidates.length} differently normalized entries; none is the NFC spelling`,
    );
  }
  return candidates[0];
}

async function listDirectory(directory: string, relPath: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw notFound(relPath);
    throw error;
  }
}

/** Resolves `candidate` through any symlink and refuses it when the real path leaves the vault. */
async function containedRealpath(root: string, candidate: string, relPath: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notFound(relPath);
    throw error;
  }
  if (!isWithin(root, resolved)) {
    throw new ReadExactError("READ_EXACT_ESCAPE", `${JSON.stringify(relPath)} resolves outside the vault`);
  }
  return resolved;
}

// O_NOFOLLOW refuses a final component swapped for a symlink after realpath; O_NONBLOCK keeps
// a FIFO from blocking the open. Windows lacks both, so each falls back to 0 there.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export async function readExact(vaultRoot: string, relPath: string): Promise<ReadExactResult> {
  const segments = segmentsOf(relPath);
  const root = await realpath(vaultRoot);
  const onDisk: string[] = [];
  let current = root;
  for (const segment of segments) {
    const entry = matchEntry(await listDirectory(current, relPath), segment, relPath);
    if (entry === undefined) throw notFound(relPath);
    onDisk.push(entry);
    // Every directory is contained before it is listed, so a symlink out of the vault
    // cannot reveal which names exist behind it.
    current = await containedRealpath(root, path.join(current, entry), relPath);
  }

  const handle = await open(current, OPEN_FLAGS);
  let bytes: Buffer;
  try {
    if (!(await handle.stat()).isFile()) {
      throw new ReadExactError("READ_EXACT_NOT_FILE", `${JSON.stringify(relPath)} is not a file`);
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  return {
    path: onDisk.join("/"),
    content: bytes.toString("utf8"),
    revision: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

/** One document in the `note get` / `search` document shape, plus the content revision. */
export interface ReadExactDocument extends ReadExactResult {
  /** The path as the caller requested it. */
  readonly target: string;
}

export interface ReadExactDocumentResult {
  readonly available: boolean;
  readonly reason?: string;
  readonly documents: ReadExactDocument[];
}

/**
 * `readExact` wrapped in the document-result shape shared by `oms search --path` and
 * the MCP `search` `path` parameter. A path the caller got wrong (invalid, missing,
 * ambiguous, escaping, not a file) is an unavailable result; an I/O failure is thrown.
 */
export async function readExactDocument(vaultRoot: string, relPath: string): Promise<ReadExactDocumentResult> {
  try {
    const result = await readExact(vaultRoot, relPath);
    return { available: true, documents: [{ target: relPath, ...result }] };
  } catch (error) {
    if (error instanceof ReadExactError) return { available: false, reason: error.message, documents: [] };
    throw error;
  }
}
