import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ENGINE_STORE_FILENAME } from "../paths.js";
import { fileMetadataWitness } from "../../conventions/file-snapshot.js";

export interface EngineStoreReadSnapshot {
  readonly dbPath: string;
  dispose(): void;
}

interface CapturedFile {
  readonly digest: string;
  readonly metadata: BigIntStats;
}

type CaptureResult =
  | { readonly status: "captured"; readonly file: CapturedFile }
  | { readonly status: "missing" }
  | { readonly status: "unstable" };

interface ReadSnapshotOptions {
  readonly afterRead?: (filename: string) => void;
}

const SNAPSHOT_ATTEMPTS = 3;
const SNAPSHOT_BUFFER_BYTES = 1024 * 1024;

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Strong identities compare exactly; weak fields never substitute for byte hashing. */
function sameMetadata(left: BigIntStats, right: BigIntStats): boolean {
  if (!left.isFile() || !right.isFile() || left.size !== right.size) return false;
  const a = fileMetadataWitness(left);
  const b = fileMetadataWitness(right);
  if (a !== null && b !== null) return a === b;
  for (const field of ["dev", "ino"] as const) {
    if (left[field] > 0n && right[field] > 0n && left[field] !== right[field]) return false;
  }
  for (const field of ["mtimeNs", "ctimeNs"] as const) {
    const x = left[field], y = right[field];
    if (typeof x === "bigint" && typeof y === "bigint" && x > 0n && y > 0n
      && x % 1_000_000n !== 0n && y % 1_000_000n !== 0n && x !== y) return false;
  }
  return true;
}

function writeChunk(fd: number, buffer: Buffer, length: number): void {
  let written = 0;
  while (written < length) {
    const count = writeSync(fd, buffer, written, length - written);
    if (count <= 0) throw new Error("Could not complete an engine snapshot write.");
    written += count;
  }
}

function captureFile(filename: string, buffer: Buffer, destination: string | undefined, afterRead?: (filename: string) => void): CaptureResult {
  let before: BigIntStats;
  try { before = statSync(filename, { bigint: true }); }
  catch (error) { if (isMissingFileError(error)) return { status: "missing" }; throw error; }
  if (!before.isFile() || before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) return { status: "unstable" };

  let input: number | undefined;
  let output: number | undefined;
  try {
    // NONBLOCK prevents a substituted FIFO from hanging a snapshot operation.
    input = openSync(filename, constants.O_RDONLY | constants.O_NONBLOCK);
    const opened = fstatSync(input, { bigint: true });
    if (!sameMetadata(before, opened)) return { status: "unstable" };
    if (destination !== undefined) output = openSync(destination, "w", 0o600);
    const hash = createHash("sha256");
    const length = Number(opened.size);
    let offset = 0;
    while (offset < length) {
      const count = readSync(input, buffer, 0, Math.min(buffer.length, length - offset), offset);
      if (count === 0) return { status: "unstable" };
      hash.update(buffer.subarray(0, count));
      if (output !== undefined) writeChunk(output, buffer, count);
      offset += count;
    }
    afterRead?.(filename);
    const handleAfter = fstatSync(input, { bigint: true });
    const after = statSync(filename, { bigint: true });
    if (!sameMetadata(opened, handleAfter) || !sameMetadata(handleAfter, after)) return { status: "unstable" };
    return { status: "captured", file: { digest: hash.digest("hex"), metadata: after } };
  } catch (error) {
    if (isMissingFileError(error)) return { status: "unstable" };
    throw error;
  } finally {
    try { if (input !== undefined) closeSync(input); }
    finally { if (output !== undefined) closeSync(output); }
  }
}

function sameCapture(left: CaptureResult, right: CaptureResult): boolean {
  if (left.status === "unstable" || right.status === "unstable") return false;
  if (left.status === "missing" || right.status === "missing") {
    return left.status === right.status;
  }
  return left.file.digest === right.file.digest && sameMetadata(left.file.metadata, right.file.metadata);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function sourceVaultRoot(source: string): string {
  const sourceDirectory = path.dirname(source);
  const root = path.basename(source) === ENGINE_STORE_FILENAME &&
    path.basename(sourceDirectory) === ".oms"
    ? path.dirname(sourceDirectory)
    : sourceDirectory;
  return realpathSync(root);
}

/** Bounded, handle-verified digest for generation checks on weak-metadata filesystems. */
export function hashReadSnapshotFile(source: string): string | null {
  const captured = captureFile(source, Buffer.allocUnsafe(SNAPSHOT_BUFFER_BYTES), undefined);
  if (captured.status === "missing") return null;
  if (captured.status === "unstable") throw new Error("Engine store changed while hashing its generation; retry the search.");
  return captured.file.digest;
}

/**
 * Copy a stable SQLite database and its committed WAL without opening the source.
 *
 * The pair is read twice and accepted only when both files and their metadata are
 * unchanged across the complete capture. SQLite recovery may then create SHM, but
 * only beside the disposable copy in the operating-system temporary directory.
 * One bounded buffer streams the first pair to that copy and hashes the second
 * pair; source images are never retained as whole-file JavaScript Buffers.
 */
export function createEngineStoreReadSnapshot(
  source: string,
  options: ReadSnapshotOptions = {},
): EngineStoreReadSnapshot | null {
  if (!existsSync(source)) return null;

  const vaultRoot = sourceVaultRoot(source);
  const temporaryRoot = realpathSync(tmpdir());
  if (isWithin(vaultRoot, temporaryRoot)) {
    throw new Error(
      `Cannot create a read-only engine snapshot: temporary directory "${temporaryRoot}" is inside source vault "${vaultRoot}". Configure TMPDIR outside the vault.`,
    );
  }

  const directory = mkdtempSync(path.join(temporaryRoot, "oms-engine-read-"));
  const dbPath = path.join(directory, "snapshot.sqlite");
  const buffer = Buffer.allocUnsafe(SNAPSHOT_BUFFER_BYTES);
  try {
    for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
      // Remove a prior attempt's WAL, including when the next capture sees it
      // absent. No SQLite handle sees these files until both passes agree.
      rmSync(`${dbPath}-wal`, { force: true });
      const firstMain = captureFile(source, buffer, dbPath, options.afterRead);
      const firstWal = captureFile(`${source}-wal`, buffer, `${dbPath}-wal`, options.afterRead);
      const secondMain = captureFile(source, buffer, undefined, options.afterRead);
      const secondWal = captureFile(`${source}-wal`, buffer, undefined, options.afterRead);
      if (firstMain.status === "captured" &&
        sameCapture(firstMain, secondMain) &&
        sameCapture(firstWal, secondWal)) {
        return {
          dbPath,
          dispose: () => rmSync(directory, { recursive: true, force: true }),
        };
      }
    }
    throw new Error(
      `Engine store changed while capturing a read-only snapshot at "${source}". Retry when the current write completes.`,
    );
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
