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
body/frontmatter; placement and naming derive the path. For append/update, pass
`notePath` without a caller-selected `templateId`; OMS resolves the persisted
note identity. The actual Obsidian template supplies frontmatter shape and body
scaffolding; OMS applies the vault-wide base defaults and policy.

Document reads do not use `write`. Use `search { op: "get-document" }` with
exactly one of a single `target`, multiple `targets`, or `notePath` plus a
window. Do not call removed document-read operations or aliases.

## Templates

Template changes use `op: "template"` with `mode: "create" | "update" |
"reclassify" | "relocate-folder" | "register-folder" | "register-existing" |
"remove" | "default"`.

1. Submit `dryRun: true`; the server derives and verifies current state, input,
   and source signatures. Do not supply or invent expected-state digests.
2. Show the resulting proposal and `approvalDigest`.
3. Apply only with `dryRun: false` and that exact caller-approved digest.

Never self-approve, hand-edit the derived `.oms/types.json`, or directly edit a managed template.

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
