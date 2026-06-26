---
name: glossary
description: Build an interlinked glossary in the vault — hub/MOC note plus one note per coined term, cross-linked with [[wikilinks]], routed through capture safety rails.
---

# oms-glossary

Thin pointer to `core/skills/glossary`. Requires `OMS_VAULT`.

Ask for a topic and term list (or extract terms from freeform text). Resolve the target folder from `vault/.oms/taxonomy.yaml`. Apply the admission gate: coined/proper terms (only ever mean one technical thing) → standalone note; general nouns (meaning shifts by domain) → section in the hub note. Deduplicate via `oms_capture_prepare` — if `exists: true`, reuse the `[[wikilink]]` and skip. Draft coined-term notes (definition + `## See Also` back-link to the hub). Draft the hub/MOC note (general-noun sections + `## See Also` links to coined-term notes). Commit terms first, hub last, via `oms_capture_commit`. Run `oms doctor` (non-blocking, exits 0).

NOTE: General nouns like `Pod`, `Service`, `Deployment` belong in hub sections. Coined terms like `ReplicaSet`, `StatefulSet`, `DaemonSet` get their own notes. Never create a standalone note for a term whose meaning is domain-dependent.
