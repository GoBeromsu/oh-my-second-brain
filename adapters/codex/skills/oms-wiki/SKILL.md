---
name: oms-wiki
description: Two-path wiki skill — Path A (M3 engine): promote compiled concepts from processed/ into the wiki/ query surface; Path B (human authoring): build interlinked terminology notes in vault taxonomy folders via capture safety rails.
---

# oms-wiki

Thin pointer to `core/skills/wiki`. Requires `OMS_VAULT`.

Determine which path applies before acting. These paths are **mutually exclusive**.

## Path A — M3 promotion engine

*(Use only when `processed/<concept>.md` already exists.)*

Rules:

1. Verify `processed/<concept>.md` exists (Phase-B compile output from M2).
2. Load staleness ledger from `.llmwiki/staleness.json`.
3. Run `runCollection()`: promotes `processed/→wiki/`, updates ledger, flips cascade backlinks, detects stubs and orphans.
4. Regenerate `wiki/index.md` and append to `wiki/log.md` via `regenerateIndex()` and `appendLog()`.
5. Run `runLint()`: auto-fix (index consistency, broken links, See-Also) and report-only (conflicts, orphans, outdated refs).
6. `promoteToWiki()` in `collection.ts` is the sole entry point into `wiki/`. Never write `processed/` from this skill.

NOTE: `processed/` is engine-internal — never synced to the Obsidian vault. Only `wiki/` crosses the sync boundary.

## Path B — Human authoring

*(Use when you have only a topic + terms and no compiled `processed/` output.)*

Rules:

1. Ask the user for a **topic** and **term list** (or extract terms from freeform source text).
2. Resolve the **target concept/folder** from `vault/.oms/taxonomy.yaml`.
3. Apply the **admission gate** to every term:
   - Coined/proper term (only ever means one specific technical thing) → standalone note.
   - General noun (meaning shifts by domain) → `## Term` section inside the hub note only.
   - K8s example: `Pod`, `Service`, `Deployment`, `Ingress` → hub sections; `ReplicaSet`, `StatefulSet`, `DaemonSet`, `CronJob` → standalone notes.
4. **Deduplicate**: call `oms_capture_prepare` for each coined term; if `exists: true`, reuse the `[[wikilink]]` and skip creation.
5. Draft coined-term notes: frontmatter from the concept's required fields + definition + `## See Also` back-link to the hub. Commit terms first via `oms_capture_commit`.
6. Draft hub/MOC note: general-noun `## Term` sections + `## See Also` listing all coined-term `[[wikilinks]]`. Commit hub last via `oms_capture_commit`.
7. Run `oms doctor` after all notes are committed (non-blocking, exits 0).

NOTE: Path B writes to vault taxonomy folders — **never to `wiki/`**. Never use `promoteToWiki()` or `runCollection()` in Path B.
