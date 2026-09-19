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

## Template source and review

An explicitly selected template folder makes every `.md` beneath it a source
candidate; no per-file registration or folder mode is required. Review verifies
the source and leaves its bytes in place. A changed source makes only the
dependent template pending, so unrelated template writes remain available;
shared-authority failures still fail closed for the whole vault.

Surface a source-change notice exactly as `템플릿에 변경이 있습니다` with
exactly `확인하기` and `나중에`. Do not render a template name, hash, or change
taxonomy in the initial notice. `나중에` is host-only: it makes no server call
and does not mutate the interview ledger. Surface a returned `templateNotice`
in long-lived sessions even when boot instructions are stale.

`확인하기` starts MCP `write { op: "template", mode: "interview-next" }`.
Submit answers with `interview-answer`, then use `commit-contracts` only after
all required questions and the user's approval of the exact final digest.
Forward the server-returned next/request/CAS fields without inventing parameter
names. The exact CLI counterparts are `oms template review`, `oms template
answer`, and `oms template commit`; never self-approve.

At note creation, placement is explicit caller folder, then the taxonomy
default, then `ask`. Template registration is not a placement prerequisite, and
there is no invented Inbox fallback.
