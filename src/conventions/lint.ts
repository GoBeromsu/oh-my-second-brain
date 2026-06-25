import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseNote } from "./frontmatter.js";
import { walkVaultMarkdown, mapWithConcurrency } from "./vault-walk.js";

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
  for await (const p of walkVaultMarkdown(vault)) {
    allPaths.push(p);
  }

  const noteIndex = buildNoteIndex(allPaths);
  const brokenLinks: BrokenLink[] = [];
  const incomingCount = new Map<string, number>(allPaths.map((p) => [p, 0]));

  // Read + extract links in parallel (I/O-bound), then resolve sequentially in
  // path order so brokenLinks ordering stays deterministic.
  const perNote = await mapWithConcurrency(allPaths, 64, async (notePath) => {
    try {
      const raw = await readFile(path.join(vault, notePath), "utf-8");
      return { notePath, targets: extractWikilinks(parseNote(raw).body) };
    } catch {
      return { notePath, targets: [] as string[] };
    }
  });

  for (const { notePath, targets } of perNote) {
    for (const target of targets) {
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
