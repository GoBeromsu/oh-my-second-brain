/**
 * Disk-persisted SHA cache for the compile engine.
 *
 * Persists to .llmwiki/sha-cache.json inside the configured dotfolder.
 * .llmwiki is a never-synced dotfolder (not committed to git, not synced by Obsidian).
 *
 * SHA-incremental pattern: bstack `terminology` skill (self-authored, Steps 2-4).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

// ---------------------------------------------------------------------------
// SHA utilities
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex digest of the given content string. */
export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Compute a stable fingerprint SHA for a set of materials.
 *
 * Materials are sorted by path before hashing so order does not matter.
 * The fingerprint changes when any material's path or text changes, or
 * when materials are added or removed.
 */
export function fingerprint(materials: ReadonlyArray<{ path: string; text: string }>): string {
  const sorted = [...materials].sort((a, b) => a.path.localeCompare(b.path));
  const combined = sorted.map((m) => `${m.path}\x00${m.text}`).join("\x01");
  return sha256(combined);
}

// ---------------------------------------------------------------------------
// Cache file path
// ---------------------------------------------------------------------------

function cacheFilePath(dotLlmwiki: string): string {
  return path.join(dotLlmwiki, "sha-cache.json");
}

// ---------------------------------------------------------------------------
// SHA cache type
// ---------------------------------------------------------------------------

/** Maps concept ID (vault-relative path) → SHA-256 of last compiled material fingerprint. */
export type SHACache = Record<string, string>;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Load the SHA cache from disk.
 * Returns an empty cache if the file is absent or unreadable.
 */
export async function loadSHACache(dotLlmwiki: string): Promise<SHACache> {
  try {
    const raw = await readFile(cacheFilePath(dotLlmwiki), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as SHACache;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Persist the SHA cache to disk.
 * Creates the dotLlmwiki directory if it does not exist.
 */
export async function saveSHACache(dotLlmwiki: string, cache: SHACache): Promise<void> {
  await mkdir(dotLlmwiki, { recursive: true });
  await writeFile(cacheFilePath(dotLlmwiki), JSON.stringify(cache, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * Compare a new material-fingerprint SHA against the cached value for `conceptId`.
 *
 * Returns:
 * - `"new"`       — concept not yet in cache (first compile)
 * - `"unchanged"` — SHA matches; skip recompile (R12 incremental)
 * - `"changed"`   — SHA differs; trigger recompile
 */
export function diffSHA(
  cache: SHACache,
  conceptId: string,
  newSHA: string,
): "unchanged" | "changed" | "new" {
  const cached = cache[conceptId];
  if (cached === undefined) return "new";
  if (cached === newSHA) return "unchanged";
  return "changed";
}
