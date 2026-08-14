---
name: oms-write
description: Write a vault note through the Oh My Second Brain kernel contract.
---

# oms-write

Call MCP `write`. Do not use host Write/Edit for vault `.md` files.

`mode` is `create`, `append`, or `update`. The kernel owns `.oms` and returns `ask`, `inbox`, `written`, or `rejected`.
