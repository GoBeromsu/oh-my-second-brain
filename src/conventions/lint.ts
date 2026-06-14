import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseNote } from "./frontmatter.js";

// Folders skipped during vault walks (same set as graph/cache.ts).
const SKIP_DIRS = new Set([
  ".oms", ".obsidian", ".trash", ".git", ".claude",
  "_archive", "node_modules",
]);

export interface BrokenLink {
  notePath: string;
  target: string;
}

export interface VaultLintResult {
  brokenLinks: BrokenLink[];
  /** Relative paths of notes that no other note links to. */
  orphanPaths: string[];
  totalNotes: number;
}

async function* walkMarkdown(dir: string, base: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(full, base);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield path.relative(base, full).replace(/\\/g, "/");
    }
  }
}

const WIKILINK_RE = /\[\[([^\]|#\n]+?)(?:[#|][^\]]*?)?\]\]/g;

export function extractWikilinks(body: string): string[] {
  const links = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(WIKILINK_RE.source, "g");
  while ((match = re.exec(body)) !== null) {
    const target = match[1]?.trim();
    if (target) links.add(target);
  }
  return Array.from(links);
}

/**
 * Build a lookup from lowercased note basename (no extension) to first-seen path.
 * Matches Obsidian's "shortest path wins" resolution.
 */
function buildNoteIndex(notePaths: readonly string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const p of notePaths) {
    const key = path.basename(p, ".md").toLowerCase();
    if (!index.has(key)) index.set(key, p);
  }
  return index;
}

/**
 * Detect broken wikilinks and orphan notes across a vault.
 *
 * A wikilink `[[Target]]` is broken when no .md file with the basename
 * "Target" (case-insensitive) exists in the vault.
 *
 * A note is an orphan when zero other notes link to it.
 */
export async function detectLinkIssues(vault: string): Promise<VaultLintResult> {
  const allPaths: string[] = [];
  for await (const p of walkMarkdown(vault, vault)) {
    allPaths.push(p);
  }

  const noteIndex = buildNoteIndex(allPaths);
  const brokenLinks: BrokenLink[] = [];
  const incomingCount = new Map<string, number>(allPaths.map((p) => [p, 0]));

  for (const notePath of allPaths) {
    let raw: string;
    try {
      raw = await readFile(path.join(vault, notePath), "utf-8");
    } catch {
      continue;
    }
    const { body } = parseNote(raw);
    for (const target of extractWikilinks(body)) {
      const resolved = noteIndex.get(target.toLowerCase());
      if (resolved === undefined) {
        brokenLinks.push({ notePath, target });
      } else {
        incomingCount.set(resolved, (incomingCount.get(resolved) ?? 0) + 1);
      }
    }
  }

  const orphanPaths = allPaths.filter((p) => (incomingCount.get(p) ?? 0) === 0);

  return { brokenLinks, orphanPaths, totalNotes: allPaths.length };
}
