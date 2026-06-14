/**
 * Karpathy navigation surfaces.
 *
 * wiki/index.md — global catalog, regenerated from scratch after every compile run.
 * wiki/log.md   — append-only compile log: "## [YYYY-MM-DD] compile | ConceptName"
 *
 * Both files are ALWAYS written before the collection owner returns.
 *
 * Date is an injected/parameter value — pass a NowFn so tests are deterministic.
 * Never call Date.now() or new Date() inline inside these functions.
 *
 * Idea absorption: Karpathy wiki gist (no license declared) — navigation conventions only.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NowFn } from "./types.js";

// ---------------------------------------------------------------------------
// File paths (exported for use by lint.ts)
// ---------------------------------------------------------------------------

export function indexPath(wikiDir: string): string {
  return path.join(wikiDir, "index.md");
}

export function logPath(wikiDir: string): string {
  return path.join(wikiDir, "log.md");
}

// ---------------------------------------------------------------------------
// Index — regenerated after every compile run
// ---------------------------------------------------------------------------

/**
 * Regenerate wiki/index.md as a global concept catalog.
 *
 * Replaces the file completely each call — callers pass the full sorted
 * concept list so the index always reflects current wiki state.
 *
 * @param wikiDir    - Absolute path to the wiki/ directory.
 * @param conceptIds - Sorted list of concept IDs to include.
 * @param now        - Injected clock returning ISO-8601 string.
 */
export async function regenerateIndex(
  wikiDir: string,
  conceptIds: readonly string[],
  now: NowFn,
): Promise<void> {
  await mkdir(wikiDir, { recursive: true });

  const date = now().slice(0, 10); // YYYY-MM-DD
  const lines: string[] = [
    `# Wiki Index`,
    ``,
    `> Generated: ${date}`,
    ``,
    `## Concepts`,
    ``,
  ];

  for (const id of conceptIds) {
    const name = path.basename(id, ".md");
    lines.push(`- [[${name}]]`);
  }

  await writeFile(indexPath(wikiDir), lines.join("\n") + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Log — append-only
// ---------------------------------------------------------------------------

/**
 * Append an entry to wiki/log.md.
 *
 * Format per line: "## [YYYY-MM-DD] compile | ConceptName"
 *
 * Log is append-only — never overwrites or truncates existing content.
 * Creates the file on first call.
 *
 * @param wikiDir     - Absolute path to the wiki/ directory.
 * @param conceptName - Human-readable concept name.
 * @param now         - Injected clock returning ISO-8601 string.
 */
export async function appendLog(
  wikiDir: string,
  conceptName: string,
  now: NowFn,
): Promise<void> {
  await mkdir(wikiDir, { recursive: true });

  const date = now().slice(0, 10); // YYYY-MM-DD
  const entry = `## [${date}] compile | ${conceptName}\n`;

  let existing = "";
  try {
    existing = await readFile(logPath(wikiDir), "utf8");
  } catch {
    // File doesn't exist yet — start fresh
  }

  await writeFile(logPath(wikiDir), existing + entry, "utf8");
}
