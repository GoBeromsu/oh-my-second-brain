---
name: link
description: Check, suggest, or apply safe vault wikilinks without changing repository bridges.
mcp_tool: link
mcp_args:
  op: "suggest"
  notePath: "$1"
---

# link

Check, suggest, or apply `[[wikilinks]]` between vault notes. Repository bridge
configuration is a separate CLI-only capability.

## Use when

Use CLI `oms link check` for read-only link validation. Use MCP `link` with
`op: "suggest"` before writing or revising a note, or `op: "apply"` to add only
accepted suggestions to an existing note.

## Usage

```text
/link <suggest|apply> <vault-relative-note-path>
```

Link targets are term notes only. Suggestions are surface-anchored, add at most one link per target in a body, and report ambiguous matches rather than resolving them. Applying suggestions writes through the vault write kernel and requires the suggestion's `baseContentHash` and accepted candidate IDs.

`oms bridge add|remove|status` manages repository bridges and has no MCP
operation. Do not route bridge work through `link`, and do not use retired
command aliases. Checking and suggesting are read-only. Apply only links the
user accepted; never infer consent from a suggestion and never expose private
note content.
