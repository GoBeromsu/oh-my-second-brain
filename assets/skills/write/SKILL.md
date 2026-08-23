---
name: write
description: Write a vault note through the Oh My Second Brain kernel contract.
mcp_tool: oms_write
mcp_args:
  mode: "$1"
  notePath: "$2"
  body: "$3"
---

# write

Write, append to, or update a vault note through the MCP write kernel. Do not use host Write/Edit for vault `.md` files.

## Use when

Use this skill for every vault-note mutation.

## Usage

```text
/write <create|append|update> <vault-relative-note-path> [body]
```

`mode` is `create`, `append`, or `update`. The kernel owns `.oms` and returns one status:

- `ask` — fill the missing or invalid fields and call `write` again
- `inbox` — tell the user; do not invent a folder
- `written` — done
- `rejected` — fix `violations` or `reason` and call `write` again
