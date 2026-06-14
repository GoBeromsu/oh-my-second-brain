/**
 * Staleness ledger — 5-state FSM for wiki pages.
 *
 * Persists to .llmwiki/staleness.json (human-readable, never synced dotfolder).
 * All state is plain disk JSON written only on explicit calls (R2: stateless/manual).
 * No daemon, no watcher, no setInterval.
 *
 * Pass the dotLlmwiki dir in — no hardcoded vault path.
 *
 * Full-rebuild escape hatch: delete .llmwiki/staleness.json → every known page
 * resets to DIRTY on the next loadLedger call.
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LedgerEntry, NowFn, StalenessLedger, StalenessState } from "./types.js";

// ---------------------------------------------------------------------------
// File path
// ---------------------------------------------------------------------------

function ledgerFilePath(dotLlmwiki: string): string {
  return path.join(dotLlmwiki, "staleness.json");
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Load the staleness ledger from disk.
 * Returns an empty ledger if the file is absent or unreadable.
 */
export async function loadLedger(dotLlmwiki: string): Promise<StalenessLedger> {
  try {
    const raw = await readFile(ledgerFilePath(dotLlmwiki), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as StalenessLedger;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Persist the staleness ledger to disk.
 * Creates the dotLlmwiki directory if it does not exist.
 */
export async function saveLedger(dotLlmwiki: string, ledger: StalenessLedger): Promise<void> {
  await mkdir(dotLlmwiki, { recursive: true });
  await writeFile(ledgerFilePath(dotLlmwiki), JSON.stringify(ledger, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function makeEntry(
  state: StalenessState,
  now: NowFn,
  extra?: Partial<LedgerEntry>,
): LedgerEntry {
  return { state, updatedAt: now(), ...extra };
}

// ---------------------------------------------------------------------------
// State transitions — pure functions returning a new ledger
// ---------------------------------------------------------------------------

/** Mark a concept DIRTY (source SHA changed or cascade flip). */
export function transitionDirty(
  ledger: StalenessLedger,
  conceptId: string,
  now: NowFn,
): StalenessLedger {
  return { ...ledger, [conceptId]: makeEntry("DIRTY", now) };
}

/** Mark a concept CLEAN (compile output produced successfully). */
export function transitionClean(
  ledger: StalenessLedger,
  conceptId: string,
  now: NowFn,
): StalenessLedger {
  return { ...ledger, [conceptId]: makeEntry("CLEAN", now) };
}

/** Mark a concept STUB (referenced by wikilinks but no compile output exists). */
export function transitionStub(
  ledger: StalenessLedger,
  conceptId: string,
  now: NowFn,
): StalenessLedger {
  return { ...ledger, [conceptId]: makeEntry("STUB", now) };
}

/** Mark a concept ORPHAN (no incoming wikilinks from any other wiki page). */
export function transitionOrphan(
  ledger: StalenessLedger,
  conceptId: string,
  now: NowFn,
): StalenessLedger {
  return { ...ledger, [conceptId]: makeEntry("ORPHAN", now) };
}

/**
 * Mark a concept CONFLICT (two compile sources produced conflicting content).
 *
 * @param conflictNote - Human-readable description of the conflict.
 *   Format: "A claims X; B claims Y" — surfaced in lint as:
 *   "> **Conflict:** A claims X; B claims Y. Unresolved."
 */
export function transitionConflict(
  ledger: StalenessLedger,
  conceptId: string,
  now: NowFn,
  conflictNote: string,
): StalenessLedger {
  return { ...ledger, [conceptId]: makeEntry("CONFLICT", now, { conflictNote }) };
}

// ---------------------------------------------------------------------------
// Escape hatch: reset by deleting staleness.json
// ---------------------------------------------------------------------------

/**
 * Full-rebuild escape hatch: delete staleness.json and return all known concept IDs
 * re-marked as DIRTY.
 *
 * If the file doesn't exist, is a no-op (returns empty ledger).
 * The caller must call saveLedger() to persist the reset state.
 */
export async function resetLedger(
  dotLlmwiki: string,
  now: NowFn,
): Promise<StalenessLedger> {
  const current = await loadLedger(dotLlmwiki);

  try {
    await unlink(ledgerFilePath(dotLlmwiki));
  } catch {
    // File doesn't exist — that's fine
  }

  const reset: StalenessLedger = {};
  for (const conceptId of Object.keys(current)) {
    reset[conceptId] = makeEntry("DIRTY", now);
  }
  return reset;
}

// ---------------------------------------------------------------------------
// Cascade integration
// ---------------------------------------------------------------------------

/**
 * Consume affected_backlinks from an M2 compile cascade return.
 *
 * For each affected page: if the current state is CLEAN, flip to DIRTY and
 * queue for the next compile run. Other states are left unchanged.
 *
 * Returns the updated ledger and the list of concept IDs that were flipped.
 */
export function applyAffectedBacklinks(
  ledger: StalenessLedger,
  affectedBacklinks: readonly string[],
  now: NowFn,
): { ledger: StalenessLedger; flipped: string[] } {
  let updated = { ...ledger };
  const flipped: string[] = [];

  for (const conceptId of affectedBacklinks) {
    if (updated[conceptId]?.state === "CLEAN") {
      updated = transitionDirty(updated, conceptId, now);
      flipped.push(conceptId);
    }
  }

  return { ledger: updated, flipped };
}
