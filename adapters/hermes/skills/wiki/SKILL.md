---
name: wiki
description: Two-path wiki skill — Path A: promote compiled concepts from processed/ into the wiki/ query surface; Path B (human authoring): build interlinked terminology notes in vault taxonomy folders via capture safety rails.
---

# oms-wiki

Thin pointer to `core/skills/wiki`. Requires `OMS_VAULT`.

**Path A — use when `processed/<concept>.md` exists:** Verify the file exists, load `.llmwiki/staleness.json`, promote `processed/→wiki/`, update the ledger, flip cascade backlinks, detect stubs and orphans. Regenerate `wiki/index.md` and append to `wiki/log.md`. Lint — auto-fix index consistency, broken `[[wikilinks]]`, and See-Also sections; report conflicts, orphans, and outdated refs. Only `wiki/` crosses the Obsidian sync boundary; `processed/` is internal.

NOTE: Delete `.llmwiki/staleness.json` to force a full rebuild — every page resets to DIRTY.

**Path B (human authoring) — use when you have only a topic + terms, no compile output:** Ask for topic and term list. Resolve the target folder from `vault/.oms/taxonomy.yaml`. Apply the admission gate: coined/proper terms (only ever mean one specific technical thing) → standalone note; general nouns (meaning shifts by domain) → `## Term` section inside the hub note only. K8s example: `Pod`, `Service`, `Deployment`, `Ingress` → hub sections; `ReplicaSet`, `StatefulSet`, `DaemonSet`, `CronJob` → standalone notes. Deduplicate via MCP `write` (`mode: "create"`) — if the note already exists, reuse the `[[wikilink]]`. Commit coined-term notes first (definition + `## See Also` back-link to hub), then commit the hub/MOC note (general-noun sections + `## See Also` links). Run `oms doctor` (non-blocking, exits 0). Writes to vault taxonomy folders — never to `wiki/`.
