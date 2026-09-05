import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ENGINE_STORE_FILENAME } from "../paths.js";

export interface EngineStoreReadSnapshot {
  readonly dbPath: string;
  dispose(): void;
}

interface CapturedFile {
  readonly bytes: Buffer;
  readonly digest: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ino: number;
}

type CaptureResult =
  | { readonly status: "captured"; readonly file: CapturedFile }
  | { readonly status: "missing" }
  | { readonly status: "unstable" };

interface ReadSnapshotOptions {
  readonly afterRead?: (filename: string) => void;
}

const SNAPSHOT_ATTEMPTS = 3;

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

function captureFile(filename: string, afterRead?: (filename: string) => void): CaptureResult {
  let before: Stats;
  try {
    before = statSync(filename);
  } catch (error) {
    if (isMissingFileError(error)) return { status: "missing" };
    throw error;
  }

  try {
    const bytes = readFileSync(filename);
    afterRead?.(filename);
    const after = statSync(filename);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== after.ino ||
      bytes.byteLength !== after.size
    ) return { status: "unstable" };
    return {
      status: "captured",
      file: {
        bytes,
        digest: createHash("sha256").update(bytes).digest("hex"),
        size: after.size,
        mtimeMs: after.mtimeMs,
        ctimeMs: after.ctimeMs,
        ino: after.ino,
      },
    };
  } catch (error) {
    if (isMissingFileError(error)) return { status: "unstable" };
    throw error;
  }
}

function sameCapture(left: CaptureResult, right: CaptureResult): boolean {
  if (left.status === "unstable" || right.status === "unstable") return false;
  if (left.status === "missing" || right.status === "missing") {
    return left.status === right.status;
  }
  return left.file.digest === right.file.digest &&
    left.file.size === right.file.size &&
    left.file.mtimeMs === right.file.mtimeMs &&
    left.file.ctimeMs === right.file.ctimeMs &&
    left.file.ino === right.file.ino;
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

/**
 * Copy a stable SQLite database and its committed WAL without opening the source.
 *
 * The pair is read twice and accepted only when both files and their metadata are
 * unchanged across the complete capture. SQLite recovery may then create SHM, but
 * only beside the disposable copy in the operating-system temporary directory.
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
  try {
    for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
      const firstMain = captureFile(source, options.afterRead);
      const firstWal = captureFile(`${source}-wal`, options.afterRead);
      const secondMain = captureFile(source, options.afterRead);
      const secondWal = captureFile(`${source}-wal`, options.afterRead);
      if (firstMain.status === "captured" &&
        sameCapture(firstMain, secondMain) &&
        sameCapture(firstWal, secondWal)) {
        writeFileSync(dbPath, firstMain.file.bytes);
        if (firstWal.status === "captured") {
          writeFileSync(`${dbPath}-wal`, firstWal.file.bytes);
        }
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
