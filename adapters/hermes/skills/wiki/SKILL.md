---
name: wiki
description: Promote compiled concepts from processed/ into the wiki/ query surface, maintain the 5-state staleness ledger, regenerate navigation surfaces (index.md + log.md), and run 2-tier lint over the wiki collection.
---

# oms-wiki

Thin pointer to `core/skills/wiki`. Requires `OMS_VAULT`.

Verify `processed/<concept>.md` exists (Phase-B compile output from M2), load staleness ledger from `.llmwiki/staleness.json`, run `runCollection()` to promote `processed/→wiki/`, update the ledger, flip cascade backlinks, detect stubs and orphans. Regenerate `wiki/index.md` and append to `wiki/log.md` via `regenerateIndex()` and `appendLog()`. Run `runLint()` — auto-fix index consistency, broken `[[wikilinks]]`, and See-Also sections; report conflicts, orphans, and outdated refs to stdout. `promoteToWiki()` in `collection.ts` is the sole entry point into `wiki/`. Only `wiki/` crosses the Obsidian sync boundary; `processed/` is engine-internal.

NOTE: Delete `.llmwiki/staleness.json` to force a full rebuild — every page resets to DIRTY.
