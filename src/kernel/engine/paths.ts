import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { digestBytes } from "../templates/canonical.js";

export const ENGINE_STORE_FILENAME = "engine-store.sqlite";

const GRAPH_CACHE_FILENAME = "graph.json";
const NODE_CACHE_FILENAME = "node-index.json";
const AXIS_CACHE_FILENAME = "axes.sqlite";
const DATABASE_COMPANION_SUFFIXES = ["-wal", "-shm", "-journal", ".lock"] as const;

function databaseCompanions(databasePath: string): readonly string[] {
  return DATABASE_COMPANION_SUFFIXES.map((suffix) => `${databasePath}${suffix}`);
}

export interface VaultCachePathOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function contained(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

interface LocatedPath {
  readonly existing: string;
  readonly resolved: string;
  readonly linkTargets: readonly string[];
}

/** Walk with lstat/readlink. A dangling symlink is not an ordinary missing directory. Creates nothing. */
function locate(candidate: string): LocatedPath {
  const absolute = path.resolve(candidate);
  let current = path.parse(absolute).root;
  const pending = absolute.slice(current.length).split(path.sep).filter((segment) => segment.length > 0);
  let existing = current;
  const linkTargets: string[] = [];
  let symlinkHops = 0;
  while (pending.length > 0) {
    const segment = pending.shift()!;
    const next = path.join(current, segment);
    let status;
    try {
      status = lstatSync(next);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      return { existing, resolved: path.resolve(current, segment, ...pending), linkTargets };
    }
    if (!status.isSymbolicLink()) {
      current = next;
      existing = realpathSync(current);
      continue;
    }
    if (++symlinkHops > 40) throw new Error(`symlink loop or traversal limit at ${next}`);
    const target = path.resolve(path.dirname(next), readlinkSync(next));
    // Reject a cache path routed through the vault even if a later link exits it.
    linkTargets.push(next, target);
    pending.unshift(...target.slice(path.parse(target).root.length).split(path.sep).filter((part) => part.length > 0));
    current = path.parse(target).root;
    existing = current;
  }
  return { existing: realpathSync(current), resolved: realpathSync(current), linkTargets };
}

function cacheBase(options: VaultCachePathOptions): string {
  const env = options.env ?? process.env;
  const configured = env.XDG_CACHE_HOME;
  if (configured !== undefined && configured.length > 0 && path.isAbsolute(configured)) return configured;
  const home = options.homeDir ?? (env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : homedir());
  return path.join(home, ".cache");
}

function insideVault(localRoot: string, candidate: string): boolean {
  return contained(localRoot, candidate);
}

/** Read-only full-path confinement for a cache root or later dbPath/cacheDir override. */
export function assertExternalCachePath(vaultPath: string, candidate: string): string {
  if (vaultPath.includes("\0") || candidate.includes("\0")) throw new Error("cache path must not contain NUL");
  const localRoot = locate(vaultPath).resolved;
  const lexical = path.resolve(candidate);
  const located = locate(lexical);
  const confined = [located.existing, located.resolved, ...located.linkTargets];
  if (confined.some((item) => insideVault(localRoot, item))) {
    throw new Error(`cache path resolves inside the vault: ${lexical}`);
  }
  let link;
  try {
    link = lstatSync(lexical);
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return lexical;
  }
  if (!link.isSymbolicLink() && link.isFile() && link.nlink > 1) {
    throw new Error(`cache path must not be hard-linked: ${lexical}`);
  }
  // A symlink's lexical nlink is the link itself. Also refuse a resolved regular
  // leaf that is hard-linked, including a hard link of a vault file.
  if (link.isSymbolicLink()) {
    let resolvedLeaf;
    try {
      resolvedLeaf = lstatSync(located.resolved);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      return lexical;
    }
    if (resolvedLeaf.isFile() && resolvedLeaf.nlink > 1) {
      throw new Error(`cache path must not be hard-linked: ${lexical}`);
    }
  }
  return lexical;
}

export function vaultCacheRoot(vaultPath: string, options: VaultCachePathOptions = {}): string {
  if (vaultPath.includes("\0")) throw new Error("vault path must not contain NUL");
  const localRoot = locate(vaultPath).resolved;
  const digest = digestBytes(localRoot).slice("sha256:".length);
  const root = path.resolve(cacheBase(options), "oms", "vaults", "v1", digest);
  const located = locate(root);
  const confined = [located.existing, located.resolved, ...located.linkTargets];
  if (confined.some((candidate) => insideVault(localRoot, candidate))) {
    throw new Error(`cache root resolves inside the vault: ${root}`);
  }
  return root;
}

export function engineStorePath(vaultPath: string, options?: VaultCachePathOptions): string {
  return assertExternalDatabasePath(vaultPath, path.join(vaultCacheRoot(vaultPath, options), ENGINE_STORE_FILENAME));
}

export function engineGraphCachePath(vaultPath: string, options?: VaultCachePathOptions): string {
  return assertExternalCachePath(vaultPath, path.join(vaultCacheRoot(vaultPath, options), "engine", GRAPH_CACHE_FILENAME));
}

export function engineNodeCachePath(vaultPath: string, options?: VaultCachePathOptions): string {
  return assertExternalCachePath(vaultPath, path.join(vaultCacheRoot(vaultPath, options), "engine", NODE_CACHE_FILENAME));
}

export function engineAxisCachePath(vaultPath: string, options?: VaultCachePathOptions): string {
  return assertExternalDatabasePath(vaultPath, path.join(vaultCacheRoot(vaultPath, options), AXIS_CACHE_FILENAME));
}

export function assertExternalDatabasePath(vaultPath: string, candidate: string): string {
  const lexical = assertExternalCachePath(vaultPath, candidate);
  const located = locate(lexical);
  assertDatabaseLeaf(lexical, "database path");
  if (located.resolved !== lexical) assertDatabaseLeaf(located.resolved, "database path");
  for (const companion of databaseCompanions(lexical)) assertDatabaseCompanion(companion);
  if (located.resolved !== lexical) {
    for (const companion of databaseCompanions(located.resolved)) assertDatabaseCompanion(companion);
  }
  return lexical;
}

function assertDatabaseLeaf(candidate: string, label: string): void {
  let status;
  try {
    status = lstatSync(candidate);
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return;
  }
  if (status.isSymbolicLink()) return;
  if (!status.isFile() || status.nlink > 1) {
    throw new Error(`${label} must be a safe regular file: ${candidate}`);
  }
}

/** Companion leaves fail closed. Parent-directory aliases stay the generic guard's job. */
function assertDatabaseCompanion(companion: string): void {
  const lexical = path.resolve(companion);
  let status;
  try {
    status = lstatSync(lexical);
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return;
  }
  if (status.isSymbolicLink()) throw new Error(`database companion must not be a symlink: ${lexical}`);
  if (!status.isFile() || status.nlink > 1) {
    throw new Error(`database companion must be a safe regular file: ${lexical}`);
  }
}
