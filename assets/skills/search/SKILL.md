---
name: search
description: Retrieve vault knowledge through declared retrieval lenses.
aliases: [retrieve]
mcp_tool: oms_search
mcp_args:
  op: "semantic-query"
  query: "$1"
---

# search

Retrieve notes and declared fields for a vault question. A lens is a vault-declared retrieval view, not an ad-hoc query filter: it identifies which fields matter for a purpose such as synthesis or audit.

## Use when

Use this skill to find and assemble relevant vault knowledge without changing the vault.

## Usage

```text
/search <query>
```

Choose the declared lens that matches the request, return only that lens's fields, and group results by concept or folder. Search may combine the live note, frontmatter, and wikilink graph with available semantic candidates; graph results remain available when the semantic index is unavailable.
