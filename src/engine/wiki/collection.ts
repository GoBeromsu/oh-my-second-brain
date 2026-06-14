/**
 * Wiki Collection Owner.
 *
 * Five responsibilities (Astro-Han collection owner pattern, MIT — idea absorption):
 *   1. Namespace / identity — concept ID → file path mapping
 *   2. Link-graph closure — verify no dangling [[wikilinks]]
 *   3. Staleness ledger — delegate to ledger.ts
 *   4. Navigation surfaces — delegate to navigation.ts
 *   5. Processed→wiki promotion — the ONLY path into wiki/
 *
 * Nvk 3-phase hard separation (Apache-2.0 — idea absorption):
 *   Research(M1) → Compile(M2, sequential) → Wiki(read-only query surface)
 *   - A wiki *query* NEVER triggers compile.
 *   - Compile NEVER writes wiki/ directly (promotion only).
 *   - wiki/ is a read-only query surface; compile writes to processed/ only.
 *   - Sync boundary: processed/ is engine-internal and is NEVER synced to the
 *     Obsidian vault. Only wiki/ crosses the Obsidian sync boundary.
 */

import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  CascadeFlipResult,
  LinkClosureResult,
  NowFn,
  StalenessLedger,
} from "./types.js";
import {
  applyAffectedBacklinks,
  loadLedger,
  saveLedger,
  transitionClean,
  transitionOrphan,
  transitionStub,
} from "./ledger.js";
import { appendLog, regenerateIndex } from "./navigation.js";

// ---------------------------------------------------------------------------
// 1. Namespace / identity
// ---------------------------------------------------------------------------

/**
 * Map a concept ID (vault-relative path) to an absolute file path in wiki/.
 * Uses only the basename so nested concept IDs are flattened to wiki/ root.
 */
export function conceptToWikiPath(wikiDir: string, conceptId: string): string {
  return path.join(wikiDir, path.basename(conceptId));
}

/**
 * Map a concept ID to its processed/ output path.
 */
export function conceptToProcessedPath(processedDir: string, conceptId: string): string {
  return path.join(processedDir, path.basename(conceptId));
}

// ---------------------------------------------------------------------------
// 2. Link-graph closure
// ---------------------------------------------------------------------------

/**
 * Extract all [[wikilink]] targets from a Markdown body.
 * Exported for use by lint.ts.
 */
export function extractWikilinks(body: string): string[] {
  const pattern = /\[\[([^\]]+)\]\]/g;
  const links: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const target = match[1];
    if (target !== undefined) links.push(target);
  }
  return links;
}

/**
 * Check link-graph closure: every [[wikilink]] in `body` must resolve to a
 * page currently present in wiki/.
 *
 * @param wikiDir - Absolute path to the wiki/ directory.
 * @param body    - Markdown body to check.
 */
export async function checkLinkClosure(
  wikiDir: string,
  body: string,
): Promise<LinkClosureResult> {
  const links = extractWikilinks(body);
  if (links.length === 0) return { dangling: [], closed: true };

  let files: string[] = [];
  try {
    files = await readdir(wikiDir);
  } catch {
    // wiki/ doesn't exist yet — every link is dangling
  }

  const pageNames = new Set(
    files
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.basename(f, ".md")),
  );

  const dangling = links.filter((link) => {
    const name = link.replace(/\.md$/, "");
    return !pageNames.has(name);
  });

  return { dangling, closed: dangling.length === 0 };
}

// ---------------------------------------------------------------------------
// 5. Processed → wiki promotion (the ONLY path into wiki/)
// ---------------------------------------------------------------------------

/**
 * Promote a compiled page from processed/ to wiki/.
 *
 * Called ONLY after the cascade pass completes.
 * Compile NEVER calls this directly — promotion is the sole entry point into wiki/.
 *
 * @param processedDir - Absolute path to the processed/ tier (Phase-B output).
 * @param wikiDir      - Absolute path to the wiki/ directory.
 * @param conceptId    - Vault-relative concept ID (basename used as filename).
 */
export async function promoteToWiki(
  processedDir: string,
  wikiDir: string,
  conceptId: string,
): Promise<void> {
  await mkdir(wikiDir, { recursive: true });
  const src = conceptToProcessedPath(processedDir, conceptId);
  const dst = conceptToWikiPath(wikiDir, conceptId);
  await copyFile(src, dst);
}

// ---------------------------------------------------------------------------
// Collection orchestration
// ---------------------------------------------------------------------------

export interface CollectionRunOptions {
  /** Absolute path to the processed/ tier (Phase-B compile output). */
  processedDir: string;
  /** Absolute path to the wiki/ directory (read-only query surface). */
  wikiDir: string;
  /** Absolute path to the .llmwiki/ dotfolder (ledger + SHA cache). */
  dotLlmwiki: string;
  /** Vault-relative concept ID that was just compiled. */
  conceptId: string;
  /** Human-readable concept name (for log.md). */
  conceptName: string;
  /** Backlinks returned by the M2 cascade pass (affected_backlinks). */
  affectedBacklinks: readonly string[];
  /** Injected clock returning ISO-8601 string. */
  now: NowFn;
}

export interface CollectionRunResult {
  /** Concept IDs whose CLEAN state was flipped to DIRTY by the cascade. */
  cascadeFlipped: CascadeFlipResult;
  /** Link-graph closure result for the newly promoted page. */
  linkClosure: LinkClosureResult;
  /** The ledger state after this run. */
  ledger: StalenessLedger;
}

/**
 * Run a full collection cycle after a successful M2 compile.
 *
 * Order (enforced to satisfy nvk 3-phase separation):
 *   1. Promote processed/→wiki/ for the compiled concept.
 *   2. Mark compiled concept CLEAN in the ledger.
 *   3. Apply cascade: flip CLEAN backlinks to DIRTY.
 *   4. Detect stubs: wikilinks in the promoted page with no wiki/ target.
 *   5. Detect orphans: wiki/ pages with no incoming wikilinks.
 *   6. Regenerate navigation surfaces (index.md + log.md).
 *   7. Persist ledger.
 *
 * A wiki *query* NEVER calls this function (nvk hard separation enforced here).
 */
export async function runCollection(
  opts: CollectionRunOptions,
): Promise<CollectionRunResult> {
  const {
    processedDir,
    wikiDir,
    dotLlmwiki,
    conceptId,
    conceptName,
    affectedBacklinks,
    now,
  } = opts;

  // Step 1: promote processed/→wiki/ (the ONLY path into wiki/)
  await promoteToWiki(processedDir, wikiDir, conceptId);

  // Load ledger
  let ledger = await loadLedger(dotLlmwiki);

  // Step 2: mark compiled concept CLEAN
  ledger = transitionClean(ledger, conceptId, now);

  // Step 3: cascade — flip CLEAN backlinks to DIRTY
  const { ledger: ledgerAfterCascade, flipped } = applyAffectedBacklinks(
    ledger,
    affectedBacklinks,
    now,
  );
  ledger = ledgerAfterCascade;

  // Step 4: detect stubs — read promoted page, check all [[wikilinks]]
  const promotedPath = conceptToWikiPath(wikiDir, conceptId);
  let promotedBody = "";
  try {
    promotedBody = await readFile(promotedPath, "utf8");
  } catch {
    // promoted file unreadable — skip stub detection
  }

  const linkClosure = await checkLinkClosure(wikiDir, promotedBody);

  for (const dangling of linkClosure.dangling) {
    // Use a stable concept ID for stub entries
    const stubId = dangling.endsWith(".md") ? dangling : `${dangling}.md`;
    const current = ledger[stubId];
    if (current === undefined || current.state === "STUB") {
      ledger = transitionStub(ledger, stubId, now);
    }
  }

  // Step 5: detect orphans — wiki/ pages with no incoming wikilinks
  let wikiFiles: string[] = [];
  try {
    wikiFiles = (await readdir(wikiDir)).filter(
      (f) => f.endsWith(".md") && f !== "index.md" && f !== "log.md",
    );
  } catch {
    // ok if dir is empty
  }

  // Build set of all link targets found across all wiki pages
  const allLinkTargets = new Set<string>();
  for (const file of wikiFiles) {
    try {
      const content = await readFile(path.join(wikiDir, file), "utf8");
      for (const link of extractWikilinks(content)) {
        allLinkTargets.add(link.replace(/\.md$/, ""));
      }
    } catch {
      // ignore unreadable files
    }
  }

  for (const file of wikiFiles) {
    const baseName = path.basename(file, ".md");
    if (!allLinkTargets.has(baseName)) {
      const fileConceptId = file; // use bare filename as ledger key for orphan entries
      ledger = transitionOrphan(ledger, fileConceptId, now);
    }
  }

  // Step 6: regenerate navigation (index.md + log.md — always written before returning)
  const cleanIds = Object.keys(ledger)
    .filter((id) => ledger[id]?.state === "CLEAN")
    .sort();
  await regenerateIndex(wikiDir, cleanIds, now);
  await appendLog(wikiDir, conceptName, now);

  // Step 7: persist ledger
  await saveLedger(dotLlmwiki, ledger);

  return {
    cascadeFlipped: { flipped },
    linkClosure,
    ledger,
  };
}
