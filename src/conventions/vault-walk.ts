import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Single source of truth for "what counts as a vault note to scan".
 *
 * Folders that are tooling/system/cache, never user notes. Every full-vault
 * walk (doctor, lint, …) should skip the same set so subsystems agree on the
 * note universe instead of each maintaining its own divergent list.
 *
 * NOTE: the engine/semantic lane (graph build, embedding sync) historically
 * uses its own narrower policies for indexing reasons and is intentionally
 * NOT migrated onto this default yet — converging it changes index contents
 * and is a separate decision.
 */
export const VAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".oms",
  ".obsidian",
  ".trash",
  ".git",
  ".claude",
  "_archive",
  "node_modules",
]);

export interface WalkOptions {
  /** Directory names to skip entirely. Default: {@link VAULT_SKIP_DIRS}. */
  skip?: ReadonlySet<string>;
  /** Skip any entry whose name starts with ".". Default: true. */
  skipDotfiles?: boolean;
  /** Base directory relative paths are computed against. Default: `root`. */
  base?: string;
}

async function* walk(
  dir: string,
  base: string,
  skip: ReadonlySet<string>,
  skipDotfiles: boolean,
): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (skip.has(name)) continue;
    if (skipDotfiles && name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (entry.isDirectory()) {
      yield* walk(full, base, skip, skipDotfiles);
    } else if (entry.isFile() && name.toLowerCase().endsWith(".md")) {
      yield path.relative(base, full).replace(/\\/g, "/");
    }
  }
}

/**
 * Recursively walk a vault, yielding POSIX-style relative paths for every
 * markdown note, skipping {@link VAULT_SKIP_DIRS} (and dotfiles) by default.
 *
 * Streaming generator: paths are produced as the tree is traversed, so memory
 * stays flat regardless of vault size.
 */
export function walkVaultMarkdown(
  root: string,
  opts: WalkOptions = {},
): AsyncGenerator<string> {
  return walk(
    root,
    opts.base ?? root,
    opts.skip ?? VAULT_SKIP_DIRS,
    opts.skipDotfiles ?? true,
  );
}

/**
 * Map over `items` with bounded concurrency, preserving input order in the
 * returned array.
 *
 * The hot cost of a vault walk is reading note *contents* (≈95% of wall time
 * on a large vault), not enumerating paths. Reading in parallel is the only
 * optimization that materially helps; the directory scan is already cheap.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
