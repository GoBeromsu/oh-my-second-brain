---
name: oms-glossary
description: Build an interlinked glossary in the vault — hub/MOC note plus one note per coined term, cross-linked with [[wikilinks]], routed through capture safety rails.
---

# oms-glossary

Thin pointer to `core/skills/glossary`. Requires `OMS_VAULT`.

Rules:

1. Ask the user for a **topic** and **term list** (or extract terms from freeform source text).
2. Resolve the **target concept/folder** from `vault/.oms/taxonomy.yaml`.
3. Apply the **admission gate** to every term:
   - Coined/proper term (only ever means one specific technical thing) → standalone note.
   - General noun (meaning shifts by domain) → `## Term` section inside the hub note only.
4. **Deduplicate**: call `oms_capture_prepare` for each coined term; if `exists: true`, reuse
   the `[[wikilink]]` and skip creation.
5. Draft one note per coined term: frontmatter from the concept's required fields + definition +
   `## See Also` back-linking to the hub.
6. Draft the hub/MOC note: general-noun sections + `## See Also` listing all coined-term `[[wikilinks]]`.
7. Commit terms first, hub last, via `oms_capture_commit`. Never skip `oms_capture_prepare`.
8. Run `oms doctor` after all notes are committed (non-blocking, exits 0).

NOTE: `oms_capture_commit` enforces vault confinement and rejects writes outside the vault,
non-`.md` paths, and `.oms/` internals. Frontmatter violations are warn-only and do not block.
