# Oh My Second Brain — Hermes

This vault uses user-owned template conventions in `.oms/`.

Before vault work:
- Actual Obsidian `.md` templates own note shape and body scaffolding.
- `.obsidian/types.json` is read-only type authority.
- The user-owned ontology remains active: `.oms/template-policy.json` records note/field meaning and policy; `.oms/taxonomy.json` records folder/link meaning and placement.
- `.oms/types.json` is derived and must never be hand-edited.
- Humans and agents use identical stable `templateId` rules.

**Write:** Use the `write` skill and MCP `oms_write`; never direct file tools for vault notes or managed templates. Notes use `op: "note"`. Template changes use `op: "template"`, dry-run first, then exact reviewed `approvalDigest`.

An explicitly selected template folder makes every `.md` beneath it a source
candidate; no per-file registration or folder mode is required. Contract review
verifies the source and preserves its bytes in place. A changed source makes
only its dependent template pending; unrelated template writes remain
available, while shared-authority failures fail closed for the whole vault.

Surface the initial source-change notice exactly as `템플릿에 변경이 있습니다`
with exactly `확인하기` and `나중에`; do not render a template name, hash, or
change taxonomy. `나중에` is host-only and makes no server call or
interview-ledger mutation. Surface returned `templateNotice` data in long-lived
sessions even when boot instructions are stale.

`확인하기` starts MCP `write { op: "template", mode: "interview-next" }`;
submit answers with `interview-answer`, then use `commit-contracts` only after
all required questions and the user's approval of the exact final digest.
Forward server-returned next/request/CAS fields without inventing parameter
names. The exact CLI counterparts are `oms template review`, `oms template
answer`, and `oms template commit`; never self-approve.

At note creation, choose placement by explicit caller folder, then taxonomy
default, then `ask`; template registration is not required and there is no
Inbox fallback.

**Retrieve:** Use `search`, discover IDs through `op: "templates"`, and filter by template, declared fields, folder, or links.

**Maintain:** `status` is read-only. `doctor` diagnoses and performs explicit repairs. Hermes installs the same seven write, search, link, distill, status, doctor, and tool-less template skills.
