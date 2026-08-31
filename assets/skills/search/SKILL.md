---
name: search
description: Retrieve vault knowledge through resolved template axes.
aliases: [retrieve]
mcp_tool: oms_search
mcp_args:
  op: "query"
  query: "$1"
---

# search

Retrieve vault knowledge without changing the vault.

## Usage

```text
/search <query>
```

Plain `query` is projection-independent lexical retrieval and remains available when no embedding provider is configured. Template-managed source files are never returned as notes.

Use `oms_search { op: "templates" }` to discover stable template IDs and declared axes. Typed queries use the same derived projection as writes:

- `axes.template` selects one stable template identity.
- `axes.field.<key>` filters a field declared by that template; values may be scalars, scalar lists, or supported predicate objects.
- `axes.folder` scopes physical placement.
- `axes.link` follows observed wikilinks.

Axes intersect. They require a current `.oms/types.json` projection and fail loudly on an undeclared field or stale signature; remove the typed axis or run template diagnosis rather than guessing. Vector or HyDE retrieval also fails loudly without configured embedding provider and model.
