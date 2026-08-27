---
name: search
description: Retrieve vault knowledge through declared retrieval lenses.
aliases: [retrieve]
mcp_tool: oms_search
mcp_args:
  op: "query"
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

## Axes

`query` scores text, so it reaches a note only where the words are actually written. A request that names a kind — a person, a meeting, a project — belongs on an axis instead: an entity note is titled with its subject and then seldom repeats it, which is precisely what text scoring cannot find.

Put the request on an axis whenever it names a kind, a declared property, or a relationship:

- `axes.field.<key>` filters on a frontmatter property declared by the vault contract. The value may be a scalar, a list of scalars (matching any of them), or a predicate object — `in`, `contains`, `containsAll`, `between`, `gte`/`gt`/`lte`/`lt`, `from`/`to`.
- `axes.folder` scopes to a top-level folder. It takes the folder's own name, not the concept name derived from it.
- `axes.link` follows the wikilink graph to reach the notes that reference an entity rather than the one describing it. It matches on filename alone: a bare title is enough, and a surrounding folder path or `.md` extension is ignored rather than narrowing the match.

Axes intersect, so a kind and a folder can be combined to narrow a single query. An axis filter is also a complete query by itself: omit `query` to enumerate a whole kind instead of searching inside it. Axis queries match lexically, so pair them with `query` or a `lex` sub-query; asking for `vec` or `hyde` retrieval alongside an axis returns nothing and says so.

Discover axes rather than guessing them. A successful query returns `facets` — the axis keys this vault actually uses, each with its observed values and their counts — and `op: "concepts"` reports the fields every concept declares. Which properties exist is a per-vault contract, so read it before filtering on it.

A rejected axis is not a failed call. The response returns `available: false` with a `reason` naming the key it refused, and comes back with `hits` and `facets` both empty — so recover by querying again without that axis and reading the facets that call returns, never by retrying the same guess. `concept` is derived from a note's folder rather than stored as a property, so scope it with `axes.folder` or with `op: "context"` — `axes.field.concept` is always refused.
