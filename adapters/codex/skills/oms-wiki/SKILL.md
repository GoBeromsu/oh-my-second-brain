---
name: oms-wiki
description: Promote compiled concepts from processed/ into the wiki/ query surface, maintain the 5-state staleness ledger, regenerate navigation surfaces (index.md + log.md), and run 2-tier lint over the wiki collection.
---

# oms-wiki

Thin pointer to `core/skills/wiki`. Requires `OMS_VAULT`.

Rules:

1. Verify `processed/<concept>.md` exists (Phase-B compile output from M2).
2. Load staleness ledger from `.llmwiki/staleness.json`.
3. Run `runCollection()`: promotes `processed/→wiki/`, updates ledger, flips cascade backlinks, detects stubs and orphans.
4. Regenerate `wiki/index.md` and append to `wiki/log.md` via `regenerateIndex()` and `appendLog()`.
5. Run `runLint()`: auto-fix (index consistency, broken links, See-Also) and report-only (conflicts, orphans, outdated refs).
6. `promoteToWiki()` in `collection.ts` is the sole entry point into `wiki/`. Never write `processed/` from this skill.

NOTE: `processed/` is engine-internal — never synced to the Obsidian vault. Only `wiki/` crosses the sync boundary.
