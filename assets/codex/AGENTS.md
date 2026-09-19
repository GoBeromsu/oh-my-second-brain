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

An explicitly selected template folder makes every `.md` beneath it a source candidate; no per-file registration or folder mode is required. Contract review verifies the selected source and preserves its bytes in place. A changed source makes only its dependent template pending; writes for other templates remain available, while a shared-authority failure remains fail-closed for the whole vault.

When a source-change notice is returned, surface the initial notice exactly as `템플릿에 변경이 있습니다` with exactly `확인하기` and `나중에`; do not add a template name, hash, or change taxonomy. `나중에` is host-only and performs no server call or interview-ledger mutation. Surface a returned `templateNotice` in long-lived sessions even when boot guidance is stale.

`확인하기` starts MCP `write { op: "template", mode: "interview-next" }`; submit answers with `interview-answer` and commit only with `commit-contracts`, forwarding the server-returned next/request/CAS fields without inventing parameter names. The exact CLI counterparts are `oms template review`, `oms template answer`, and `oms template commit`. Continue through every required question, preserve unaffected confirmed answers, and never self-approve the final digest.

At note creation, choose placement by explicit caller folder, then taxonomy default, then `ask`; do not require template registration or invent an Inbox fallback.

**Retrieve:** Use `$oms-search`; discover stable IDs with `op: "templates"`, then use template, declared field, folder, and link axes.

**Maintain:** `$oms-status` is read-only. `$oms-doctor` diagnoses and performs explicit repairs.

`oms host install --runtime codex` installs seven skills: `$oms-write`, `$oms-search`, `$oms-link`, `$oms-distill`, `$oms-status`, `$oms-doctor`, and tool-less `$oms-template`, plus managed MCP configuration using `oms serve mcp`.
