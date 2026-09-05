# Oh My Second Brain for Codex

Use Oh My Second Brain for an Obsidian/Markdown vault governed by user-owned template controls in `.oms/`.

## Core rule

Actual Obsidian Markdown templates own note shape and body scaffolding. The user-owned ontology remains active: template policy records note/field meaning and policy, while taxonomy records folder/link meaning and placement. `.obsidian/types.json` is read-only type authority; `.oms/types.json` is derived and must never be hand-edited.

## Command mapping

| User intent | Preferred surface |
|---|---|
| inspect and adopt templates | `oms setup --vault <path> --dry-run`, then `--yes --approved-digest <digest>` |
| install host integration | `oms host install --runtime codex --vault <path> --yes` |
| diagnose or repair | `$oms-doctor` or `oms template check --vault <path>`; repairs require an approved digest |
| write a note | `$oms-write` / MCP `oms_write` with a stable `templateId` |
| retrieve knowledge | `$oms-search` / MCP `oms_search`; discover IDs with `op: "templates"` |

## Safety

- Never delete vault notes or `.oms/` during uninstall.
- Never use direct file tools for vault notes or managed templates.
- Never invent required values or self-approve a repair digest.
- `status` and search are read-only; mutation requires a verified target.
