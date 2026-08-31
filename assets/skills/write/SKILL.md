---
name: write
description: Write vault notes and manage Obsidian templates through the guarded template contract.
mcp_tool: oms_write
mcp_args:
  op: "note"
  mode: "create"
  templateId: "$1"
  body: "$2"
---

# write

Use MCP `oms_write` for every vault-note or managed-template mutation. Do not use host Write/Edit for vault Markdown.

## Notes

Translate the user's natural-language note kind into a stable ID returned by `oms_search { op: "templates" }`; never guess an ID.

```text
/write <template-id> [body]
```

For create, call `op: "note"` with `mode`, `templateId`, and body/frontmatter; placement and naming derive the path. For append/update, pass `notePath` without `templateId`; OMS resolves the persisted `frontmatter.template`. The actual Obsidian template supplies frontmatter shape and body scaffolding; OMS applies the vault-wide base defaults and policy.

## Templates

Template creation, updates, reclassification, and template-folder relocation use `op: "template"` with `mode: "create" | "update" | "reclassify" | "relocate-folder"`.

1. Submit `dryRun: true` with current input and source signatures.
2. Show the resulting proposal and `approvalDigest`.
3. Apply only with `dryRun: false` and that exact caller-approved digest.

Never self-approve, hand-edit the derived `.oms/types.json`, or directly edit a managed template.

Responses are `ask`, `written`, or `rejected`. Resolve named violations and retry; never invent missing required values.
