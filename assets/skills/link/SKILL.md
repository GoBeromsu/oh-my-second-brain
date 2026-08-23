---
name: link
description: Suggest or apply safe wikilinks between vault notes.
mcp_tool: oms_link
mcp_args:
  op: "$1"
  notePath: "$2"
---

# link

Suggest or apply `[[wikilinks]]` between a note and the vault's term notes.

## Use when

Use `suggest` before writing or revising a note, or use `apply` to add accepted links to an existing note.

## Usage

```text
/link <suggest|apply> <vault-relative-note-path>
```

Link targets are term notes only. Suggestions are surface-anchored, add at most one link per target in a body, and report ambiguous matches rather than resolving them. Applying suggestions writes through the vault write kernel and requires the suggestion's `baseContentHash` and accepted candidate IDs.
