# Oh My Second Brain — Claude Code

This vault is governed by user-owned template conventions in `.oms/`.

Before vault work:
- Treat actual Obsidian `.md` templates as the note-shape and body source of truth.
- Treat `.obsidian/types.json` as read-only property-type authority.
- Read the user-owned ontology from `.oms/template-policy.json` for note/field meaning and policy, and `.oms/taxonomy.json` for folder/link meaning and placement.
- Never hand-edit derived `.oms/types.json`; use doctor diagnosis and an approved regeneration.
- People and agents follow the same stable `templateId` rules.

Writes:
- Use `/write` and MCP `oms_write`; never host Write/Edit for vault notes or managed templates.
- Notes use `op: "note"` with a stable template ID.
- Template changes use `op: "template"`: dry-run first, then apply only with the exact reviewed `approvalDigest`.

Retrieval:
- Use `/search`; discover identities with `op: "templates"`.
- Filter with template, declared field, folder, and link axes. Plain lexical search remains read-only and projection-independent.

`status` is observational. `doctor` owns explicit diagnosis and repairs. The seven installed skills are write, search, link, distill, status, doctor, and tool-less template authoring.
