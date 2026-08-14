---
name: write
description: Write a vault note through the Oh My Second Brain kernel contract.
---

# write

Vault notes go through MCP `write` only. Do not use host Write/Edit for vault `.md` files.

`mode` is `create`, `append`, or `update`. The kernel owns `.oms` and returns one status:

- `ask` — fill the missing or invalid fields and call `write` again
- `inbox` — tell the user; do not invent a folder
- `written` — done
- `rejected` — fix `violations` or `reason` and call `write` again
