---
name: wiki
version: 0.1.0
description: Promote compiled concepts from processed/ into the wiki/ query surface, maintain the 5-state staleness ledger, regenerate navigation surfaces (index.md + log.md), and run 2-tier lint over the wiki collection.
trigger: /wiki
tags: [wiki, collection, staleness, navigation, lint, second-brain, oms]
---

## wiki

Manage the wiki collection — the read-only query surface of the oh-my-secondbrain engine.

## What this skill does

1. Verify the M2 compile output exists in `processed/` for the target concept.
2. Check the staleness ledger (`.llmwiki/staleness.json`) for current state.
3. Run `runCollection()` to promote `processed/→wiki/`, update the ledger, flip cascade backlinks, detect stubs and orphans, and regenerate navigation surfaces.
4. Regenerate `wiki/index.md` (global catalog) and append an entry to `wiki/log.md`.
5. Run `runLint()` — apply auto-fixes (index consistency, broken links, See-Also) and report findings (conflicts, orphans, outdated refs) to stdout.

## 3-phase hard separation

```
Research (M1) → Compile (M2, sequential) → Wiki (read-only query surface)
```

A wiki query never triggers compile. Compile never writes `wiki/` directly.
`promoteToWiki()` in `collection.ts` is the sole entry point into `wiki/`.

**Sync boundary:** `processed/` is internal compile state and is **NEVER synced to the Obsidian vault** — only `wiki/` crosses the Obsidian sync boundary. `processed/` stays non-synced (engine-internal); `wiki/` is the synced, user-visible surface.

## Staleness states

| State | Meaning |
|-------|---------|
| `CLEAN` | Compile output matches current sources |
| `DIRTY` | Source SHA changed; needs recompile |
| `STUB` | Referenced by wikilinks but no compile output exists |
| `ORPHAN` | No incoming wikilinks from any other wiki page |
| `CONFLICT` | Two compile sources produced conflicting content |

Full-rebuild escape hatch: delete `.llmwiki/staleness.json` — every page resets to DIRTY on the next collection run.

## Lint tiers

**Auto-fix** (runs automatically, mutates `wiki/` files):
- Index consistency — page in `wiki/` but absent from `index.md`
- Internal-link correctness — broken `[[wikilinks]]` flagged
- See-Also sections — added if missing

**Report-only** (never auto-fixed without explicit `forceHumanGate` flag):
- Factual contradictions: `> **Conflict:** A claims X; B claims Y. Unresolved.`
- Orphan pages
- Outdated refs (DIRTY pages in the ledger)

## Engine

Implemented in `src/engine/wiki/`:

- `collection.ts` — `runCollection()` orchestrates the full cycle
- `ledger.ts` — 5-state FSM, `loadLedger()` / `saveLedger()` / `resetLedger()`
- `navigation.ts` — `regenerateIndex()` + `appendLog()`
- `lint.ts` — `runLint()`
- `types.ts` — local type definitions

## Example agent steps

```
User: "Promote the Alpha concept into the wiki after compile."

1. Verify processed/alpha.md exists (Phase-B compile output)
2. Load ledger from .llmwiki/staleness.json
3. runCollection({ conceptId: "concepts/alpha.md", conceptName: "Alpha", ... })
   → promotes processed/alpha.md → wiki/alpha.md
   → marks concepts/alpha.md CLEAN in ledger
   → flips CLEAN backlinks to DIRTY
   → detects stubs (dangling wikilinks) and orphans
   → regenerates wiki/index.md and appends to wiki/log.md
4. runLint({ wikiDir, ledger }) → apply auto-fixes, print report-only findings
```
