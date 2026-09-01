# Oh My Second Brain Convention Shim — Codex

<!-- Append this block to a project's AGENTS.md to activate Oh My Second Brain conventions in Codex. -->

## Vault Convention

The vault is governed by user-owned template conventions in `.oms/`.

- Actual Obsidian `.md` templates own note shape and body scaffolding.
- `.obsidian/types.json` is read-only type authority.
- The user-owned ontology remains active: `.oms/template-policy.json` records note/field meaning and policy; `.oms/taxonomy.json` records folder/link meaning and placement.
- `.oms/types.json` is derived; never hand-edit it.
- Humans and agents use the same stable `templateId` rules.

**Write:** Use `$oms-write` and MCP `oms_write`, never host Write/Edit for vault notes or managed templates. Notes use `op: "note"`. Template changes use `op: "template"`, first as a dry-run and then only with the exact reviewed `approvalDigest`.

**Retrieve:** Use `$oms-search`; discover stable IDs with `op: "templates"`, then use template, declared field, folder, and link axes.

**Maintain:** `$oms-status` is read-only. `$oms-doctor` diagnoses and performs explicit repairs.

`oms install --runtime codex` installs seven skills: `$oms-write`, `$oms-search`, `$oms-link`, `$oms-distill`, `$oms-status`, `$oms-doctor`, and tool-less `$oms-template`, plus managed MCP configuration.
