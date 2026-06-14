---
name: oms-wiki
description: Promote compiled concepts from processed/ into the wiki/ query surface, maintain the 5-state staleness ledger, regenerate navigation surfaces (index.md + log.md), and run 2-tier lint over the wiki collection.
---

# Skill: oms-wiki (Claude Code)

Promote compiled concepts into the wiki query surface and keep the staleness ledger, navigation surfaces, and lint clean.

## Invocation

```
/wiki
```

## What this skill does

Thin pointer to `core/skills/wiki`. Requires `OMS_VAULT`. Operates on the
`wiki/` query surface only — never writes to `processed/` or `src/`.

## Agent-guided steps (v0)

1. Verify `processed/<concept>.md` exists (Phase-B compile output from M2).
2. Load the staleness ledger from `.llmwiki/staleness.json`.
3. Run `runCollection()` — promotes `processed/→wiki/`, updates the ledger,
   flips cascade backlinks, and detects stubs and orphans.
4. Regenerate `wiki/index.md` (global catalog) and append an entry to `wiki/log.md`
   via `regenerateIndex()` and `appendLog()`.
5. Run `runLint()` — apply auto-fixes (index consistency, broken `[[wikilinks]]`,
   See-Also sections) and report findings (conflicts, orphans, outdated refs) to stdout.

## Staleness states

| State | Meaning |
|-------|---------|
| `CLEAN` | Compile output matches current sources |
| `DIRTY` | Source SHA changed; needs recompile |
| `STUB` | Referenced by wikilinks but no compile output exists |
| `ORPHAN` | No incoming wikilinks from any other wiki page |
| `CONFLICT` | Two compile sources produced conflicting content |

Full-rebuild escape hatch: delete `.llmwiki/staleness.json` — every page resets to DIRTY.

## Runtime

Implemented in `src/engine/wiki/`: `collection.ts` (`runCollection()`),
`ledger.ts` (`loadLedger()` / `saveLedger()` / `resetLedger()`),
`navigation.ts` (`regenerateIndex()` / `appendLog()`), `lint.ts` (`runLint()`),
`types.ts`.

`promoteToWiki()` in `collection.ts` is the sole entry point into `wiki/`.

## NOTES

`processed/` is engine-internal and is NEVER synced to the Obsidian vault —
only `wiki/` crosses the sync boundary. A wiki run never triggers compile;
compile never writes `wiki/` directly.
