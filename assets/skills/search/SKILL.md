---
name: search
description: Retrieve vault knowledge through lexical, vector, HyDE, and typed-axis search.
aliases: [retrieve]
mcp_tool: search
mcp_args:
  op: "query"
  query: "$1"
---

# search

Retrieve vault knowledge without changing the vault. Search does not depend on contract validity, note completeness, or status health. Notes that would fail the contract stay searchable. Do not add a passing-notes-only filter, and do not start a judge, a repair, or a reseal.

## Usage

```text
/search <query|context|templates|index-status|get-document>
```

- `query` accepts three shapes. `mode: "query" | "search" | "vsearch"` with a `query` string; a bare `query` string with no `mode`; or typed retrieval with `searches`, `vec`, or `hyde` and no `mode` or `query`. `mode` never combines with `searches`. Lexical retrieval reads no contract and stays available when no embedding provider is configured.
- `context` retrieves the declared search context.
- `templates` lists the sealed templates and their declared axes, or shows one template.
- `index-status` requires `view: "status" | "collections" | "contexts"`.
- `get-document` requires exactly one of `target`, `targets`, or `notePath` with its window.

Template source files are never returned as notes. Expansion is explicit only for `search { op: "query" }` through its closed strategy object and never changes a plain lexical query. Folder meanings from the sealed folder contract come back as `folderIntents`.

Typed queries intersect these axes:

- `axes.template` selects one sealed template.
- `axes.field.<key>` filters a field declared by that template; values may be scalars, scalar lists, or supported predicate objects.
- `axes.folder` scopes physical placement.
- `axes.link` follows observed wikilinks.

A typed axis fails loudly on an undeclared field. Remove the typed axis rather than guessing a field. That failure does not stop lexical retrieval. Vector or HyDE retrieval fails loudly without a configured embedding provider and model. ADR-005 applies: do not hide a provider or backend failure as an empty success, a fake embedder, or another backend. Missing results are unobserved, not proof of absence.

Search never creates `.oms` and never mutates templates, notes, the contract, or indexes. A search call does not grant edit rights.

The surface is five MCP tools and seven skills.
