---
name: write
description: Write vault notes and manage Obsidian templates through the guarded template contract.
mcp_tool: write
mcp_args:
  op: "note"
  mode: "create"
  templateId: "$1"
  body: "$2"
---

# write

Use MCP `write` for every vault-note or managed-template mutation. Do not use host Write/Edit for vault Markdown.

## Notes

Translate the user's natural-language note kind into a stable ID returned by
`search { op: "templates" }`; never guess an ID. A create may omit
`templateId` only to use the policy's declared `defaultTemplate`. If no default
is declared, report `TEMPLATE_DEFAULT_UNDECLARED`; never select the first
available template.

```text
/write [template-id] [body]
```

For create, call `op: "note"` with `mode: "create"`, optional `templateId`, and
body/frontmatter. Destination precedence is an explicit caller folder, then the
taxonomy default for that template, then `ask`; never require template
registration for placement and never fall back to Inbox. For append/update,
pass `notePath` without a caller-selected `templateId`; OMS resolves the
persisted note identity. The actual Obsidian template supplies frontmatter shape
and body scaffolding; OMS applies the vault-wide base defaults and policy.

Document reads do not use `write`. Use `search { op: "get-document" }` with
exactly one of a single `target`, multiple `targets`, or `notePath` plus a
window. Do not call removed document-read operations or aliases.

## Templates

Template source changes use separate guarded `op: "template"` operations. Source
authoring is explicit (`oms template add --id <id> --from <source>`); updates,
moves, removes, reclassification, folder scope, and defaults remain separate
operations. None of these operations is the contract-review interview, and
contract review never writes source bytes.

1. Submit `dryRun: true`; the server derives and verifies current state, input,
   and source signatures. Do not supply or invent expected-state digests.
2. Show the resulting proposal and `approvalDigest`.
3. Apply only with `dryRun: false` and that exact caller-approved digest.

When a selected-folder source changes, a `templateNotice` may accompany a
result. Surface the initial notice exactly as `템플릿에 변경이 있습니다` with
exactly `확인하기` and `나중에`; do not include a template name, hash, or
change taxonomy. `나중에` is host-only and must not call the server or mutate
the interview ledger. This notice must still be surfaced in long-lived
sessions when boot instructions are stale.

`확인하기` starts `write { op: "template", mode: "interview-next" }`. Submit
answers with `mode: "interview-answer"` using the returned question, request,
and CAS values; use the server's returned next question when resuming. Do not
invent field names or digests. Preserve unaffected confirmed answers. When no
questions remain, present the exact final approval digest and call
`mode: "commit-contracts"` only after the user approves it; never self-approve.
Only then may the guarded contract commit publish `.oms` controls. A pending
template blocks only writes that depend on that template; a shared-authority
failure remains a vault-wide fail-closed condition.

`oms template review`, `answer`, and `commit` are the exact CLI counterparts of
`interview-next`, `interview-answer`, and `commit-contracts`. `oms template scan`
is a read-only census/pending view, and `oms template add <folder>` remains an
explicit scope selection.

Every write remains verified-target. Never hand-edit the derived
`.oms/types.json`, directly edit a managed template, or self-approve.

Responses are `ask`, `written`, or `rejected`. Resolve named violations and retry; never invent missing required values.

Renderer rules for `op: "note"`: OMS renders supported Core expressions, never
executes Templater scripts. A `templater` template needs a caller value for
every `filledBy: "obsidian"` field (`FIELD_FILLED_BY_OBSIDIAN` asks for them)
and is rejected when its body contains external delimiters
(`TEMPLATE_RENDERER_EXTERNAL`); a `none` template is always rejected for note
creation. Point the user at an `obsidian-core` template or propose a converted
copy through `/template` instead of pasting raw Templater tags. Caller-supplied
values and body must not contain raw external tags either. Never expose private
note content while presenting a dry-run proposal.
