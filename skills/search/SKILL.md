---
name: search
description: Retrieve vault knowledge through resolved template axes.
aliases: [retrieve]
mcp_tool: search
mcp_args:
  op: "query"
  query: "$1"
---

# search

Retrieve vault knowledge without changing the vault.

## Usage

```text
/search <query|context|template-scan|templates|index-status|get-document>
```

- `query` requires `mode: "query" | "search" | "vsearch"` and exactly one of `query` or `searches`. Plain `mode: "query"` is projection-independent lexical retrieval and remains available when no embedding provider is configured.
- `context` retrieves the declared search context.
- `template-scan` reports template candidates without registering or writing them.
- `templates` lists templates when `templateId` is absent and shows one template when `templateId` is present.
- `index-status` requires `view: "status" | "collections" | "contexts"`.
- `get-document` requires exactly one of `target`, `targets`, or `notePath` with its window.

Do not use retired `lazy-load`, `multi-get-documents`, `collections`, `contexts`, or `status` search operations. Template-managed source files are never returned as notes. Expansion is explicit only for `search { op: "query" }` through its closed strategy object and never changes a plain lexical query.

Use `search { op: "templates" }` to list stable template IDs and declared axes, or add `templateId` to show exactly one. Typed queries use the same derived projection as writes:

- `axes.template` selects one stable template identity.
- `axes.field.<key>` filters a field declared by that template; values may be scalars, scalar lists, or supported predicate objects.
- `axes.folder` scopes physical placement.
- `axes.link` follows observed wikilinks.

Axes intersect. They require current authority and fail loudly on an undeclared field or stale signature; remove the typed axis or run template diagnosis rather than guessing. Vector or HyDE retrieval also fails loudly without a configured embedding provider and model. Missing results and history are unobserved, not proof of absence or non-use.
