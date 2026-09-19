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
- An explicitly selected template folder makes every `.md` beneath it a source candidate; no per-file registration or folder mode is required. Contract review verifies the source and leaves its bytes in place.
- A changed source makes only its dependent template pending; unrelated template writes remain available, while shared-authority failures fail closed for the whole vault.
- Surface the initial source-change notice exactly as `템플릿에 변경이 있습니다` with exactly `확인하기` and `나중에`; do not render a template name, hash, or change taxonomy. `나중에` is host-only and makes no server call or interview-ledger mutation. Surface returned `templateNotice` data in long-lived sessions even when boot instructions are stale.
- `확인하기` starts MCP `write { op: "template", mode: "interview-next" }`; answer with `interview-answer` and commit with `commit-contracts` only after all required questions and the user's approval of the exact final digest. Use server-returned next/request/CAS fields without inventing parameter names. The exact CLI counterparts are `oms template review`, `oms template answer`, and `oms template commit`; never self-approve.
- At note creation, choose placement by explicit caller folder, then taxonomy default, then `ask`; registration is not required and there is no Inbox fallback.

Retrieval:
- Use `/search`; discover identities with `op: "templates"`.
- Filter with template, declared field, folder, and link axes. Plain lexical search remains read-only and projection-independent.

`status` is observational. `doctor` owns explicit diagnosis and repairs. The seven installed skills are write, search, link, distill, status, doctor, and tool-less template authoring.
