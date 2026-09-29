import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Digest } from "../conventions/canonical.js";
import { digestBytes } from "../conventions/canonical.js";
import { DIGEST_HEX_PATTERN, digestHex, isDigest, manifestDigestOf } from "./digest.js";
import { ensureDirectory, syncDirectory } from "./fs-private.js";
import { ensureStateDir, existingStateDir } from "./state-dir.js";

/**
 * Every sealed generation's bytes, kept forever under `<root>/.<id>.state/generations/<hex>/`
 * where `<hex>` is the manifest digest without `sha256:`. The store keeps only N and N-1;
 * these snapshots are how any older generation is read back. A snapshot is written once
 * (temporary directory, fsync, rename, fsync the parent) and never changed or removed:
 * there is no delete path here, and the seal's GC matches only `.<id>.<seq>` names.
 */

const MANIFEST = "manifest.json";
const MAX_SNAPSHOT_FILE_BYTES = 4 * 1024 * 1024;
export const SNAPSHOT_TEMPORARY_PREFIX = ".tmp-";

export type SnapshotRead =
  | { readonly state: "ok"; readonly files: ReadonlyMap<string, Buffer>; readonly manifestBytes: Buffer; readonly digest: Digest }
  | { readonly state: "missing" }
  | { readonly state: "corrupt" };

/** Test seams for the publishing rename and the parent fsync; the defaults are the real calls. */
export interface SnapshotDeps {
  readonly rename?: typeof rename;
  readonly sync?: (directory: string) => Promise<void>;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readBounded(path: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SNAPSHOT_FILE_BYTES) return null;
    const bytes = await handle.readFile();
    return bytes.length > MAX_SNAPSHOT_FILE_BYTES ? null : bytes;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function listFiles(directory: string, prefix = ""): Promise<string[] | null> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = await listFiles(join(directory, entry.name), relative);
      if (nested === null) return null;
      found.push(...nested);
    } else if (entry.isFile()) {
      found.push(relative);
    } else {
      return null;
    }
  }
  return found;
}

/**
 * Reads a generation-shaped directory and checks it against its own manifest: the manifest
 * names exactly the files present, and each file's bytes match its digest. `expected`, when
 * given, must equal the manifest digest. Corrupt returns no bytes.
 */
export async function readVerifiedDirectory(directory: string, expected?: Digest): Promise<SnapshotRead> {
  let info;
  try {
    info = await lstat(directory);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing" };
    throw error;
  }
  if (!info.isDirectory()) return { state: "corrupt" };
  const manifestBytes = await readBounded(join(directory, MANIFEST));
  if (manifestBytes === null) return { state: "corrupt" };
  const digest = manifestDigestOf(manifestBytes);
  if (expected !== undefined && digest !== expected) return { state: "corrupt" };
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    return { state: "corrupt" };
  }
  if (!record(manifest) || !record(manifest["files"])) return { state: "corrupt" };
  const named = manifest["files"];
  if (!Object.values(named).every(isDigest)) return { state: "corrupt" };
  const listed = await listFiles(directory);
  if (listed === null) return { state: "corrupt" };
  const present = listed.filter(path => path !== MANIFEST);
  if (present.length !== Object.keys(named).length || !present.every(path => Object.hasOwn(named, path))) return { state: "corrupt" };
  const files = new Map<string, Buffer>();
  for (const path of Object.keys(named).sort()) {
    const bytes = await readBounded(join(directory, ...path.split("/")));
    if (bytes === null || digestBytes(bytes) !== named[path]) return { state: "corrupt" };
    files.set(path, bytes);
  }
  return { state: "ok", files, manifestBytes, digest };
}

/** The snapshot of `digest`; missing when neither it nor the snapshot directory exists. */
export async function readSnapshot(root: string, vaultId: string, digest: Digest): Promise<SnapshotRead> {
  if (!isDigest(digest)) return { state: "corrupt" };
  const directory = await existingStateDir(root, vaultId, "generations");
  if (directory === null) return { state: "missing" };
  return readVerifiedDirectory(join(directory, digestHex(digest)), digest);
}

async function writeFileSynced(path: string, content: string | Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class SnapshotCorrupt extends Error {
  readonly code = "CONTRACT_SNAPSHOT_CORRUPT";

  constructor(readonly digest: Digest) {
    super(`CONTRACT_SNAPSHOT_CORRUPT: the kept snapshot of ${digest} does not match its digest and was left untouched; run oms doctor contract`);
    this.name = "SnapshotCorrupt";
  }
}

/**
 * Publishes a generation's files and manifest as `<hex>/`. An existing `<hex>/` is only
 * verified, never rewritten; one that does not verify throws CONTRACT_SNAPSHOT_CORRUPT.
 * The caller holds the seal lock, so no other writer races the temporary name or `<hex>`.
 */
export async function writeSnapshot(
  root: string,
  vaultId: string,
  files: ReadonlyMap<string, string | Uint8Array>,
  manifestBytes: string | Uint8Array,
  deps: SnapshotDeps = {},
): Promise<{ readonly hex: string; readonly created: boolean }> {
  const parent = await ensureStateDir(root, vaultId, "generations");
  const digest = manifestDigestOf(manifestBytes);
  const hex = digestHex(digest);
  const target = join(parent, hex);
  const existing = await readVerifiedDirectory(target, digest);
  if (existing.state === "ok") return { hex, created: false };
  if (existing.state === "corrupt") throw new SnapshotCorrupt(digest);

  const temporary = join(parent, `${SNAPSHOT_TEMPORARY_PREFIX}${randomUUID()}`);
  let published = false;
  try {
    await mkdir(temporary, { mode: 0o700 });
    await ensureDirectory(temporary);
    const directories = new Set<string>([temporary]);
    for (const [path, content] of [...files].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
      const parts = path.split("/");
      for (let depth = 1; depth < parts.length; depth += 1) {
        const nested = join(temporary, ...parts.slice(0, depth));
        if (!directories.has(nested)) {
          await ensureDirectory(nested);
          directories.add(nested);
        }
      }
      await writeFileSynced(join(temporary, ...parts), content);
    }
    await writeFileSynced(join(temporary, MANIFEST), manifestBytes);
    for (const directory of [...directories].reverse()) await syncDirectory(directory);
    await (deps.rename ?? rename)(temporary, target);
    published = true;
    await (deps.sync ?? syncDirectory)(parent);
  } finally {
    if (!published) await rm(temporary, { recursive: true, force: true });
  }
  return { hex, created: true };
}

export interface SnapshotInventory {
  /** Snapshot digests present, by name; their bytes are not verified here. */
  readonly digests: readonly Digest[];
  /** Names that are neither a 64-hex snapshot nor expected: leftovers `.tmp-*` included. */
  readonly unexpected: readonly string[];
  readonly bytes: number;
}

async function sizeOf(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(path)) total += await sizeOf(join(path, entry));
  return total;
}

async function listSnapshots(directory: string): Promise<{ readonly digests: Digest[]; readonly unexpected: string[] }> {
  const digests: Digest[] = [];
  const unexpected: string[] = [];
  // Node lstats an entry itself when the file system reports no type, so `isDirectory()` is exact.
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    if (DIGEST_HEX_PATTERN.test(entry.name) && entry.isDirectory()) digests.push(`sha256:${entry.name}`);
    else unexpected.push(entry.name);
  }
  return { digests, unexpected };
}

/**
 * The snapshot digests in `generations/`, by name only (a name is its content digest):
 * one readdir, no per-snapshot stat or size walk. The seal reads this on every seal.
 */
export async function snapshotDigests(root: string, vaultId: string): Promise<readonly Digest[]> {
  const directory = await existingStateDir(root, vaultId, "generations");
  return directory === null ? [] : (await listSnapshots(directory)).digests;
}

/** What `generations/` holds, with sizes, read-only; empty when it does not exist. Doctor only. */
export async function snapshotInventory(root: string, vaultId: string): Promise<SnapshotInventory> {
  const directory = await existingStateDir(root, vaultId, "generations");
  if (directory === null) return { digests: [], unexpected: [], bytes: 0 };
  const { digests, unexpected } = await listSnapshots(directory);
  let bytes = 0;
  for (const digest of digests) bytes += await sizeOf(join(directory, digest.slice("sha256:".length)));
  return { digests, unexpected, bytes };
}

/** Removes `.tmp-*` leftovers of a crashed write. Only the seal-lock holder calls this. */
export async function removeSnapshotTemporaries(root: string, vaultId: string): Promise<number> {
  const directory = await existingStateDir(root, vaultId, "generations");
  if (directory === null) return 0;
  let removed = 0;
  for (const entry of await readdir(directory)) {
    if (!entry.startsWith(SNAPSHOT_TEMPORARY_PREFIX)) continue;
    await rm(join(directory, entry), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
