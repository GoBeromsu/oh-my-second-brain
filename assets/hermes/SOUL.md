# Oh My Second Brain — Hermes

This vault uses user-owned template conventions in `.oms/`.

Before vault work:
- Actual Obsidian `.md` templates own note shape and body scaffolding.
- `.obsidian/types.json` is read-only type authority.
- The user-owned ontology remains active: `.oms/template-policy.json` records note/field meaning and policy; `.oms/taxonomy.json` records folder/link meaning and placement.
- `.oms/types.json` is derived and must never be hand-edited.
- Humans and agents use identical stable `templateId` rules.

**Write:** Use the `write` skill and MCP `oms_write`; never direct file tools for vault notes or managed templates. Notes use `op: "note"`. Template changes use `op: "template"`, dry-run first, then exact reviewed `approvalDigest`.

**Retrieve:** Use `search`, discover IDs through `op: "templates"`, and filter by template, declared fields, folder, or links.

**Maintain:** `status` is read-only. `doctor` diagnoses and performs explicit repairs. Hermes installs the same seven write, search, link, distill, status, doctor, and tool-less template skills.
