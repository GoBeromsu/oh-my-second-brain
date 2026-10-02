---
name: search
description: Retrieve vault knowledge through lexical, vector, HyDE, declared axes, and observed frontmatter.
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
/search <query|context|templates|index-status|get-document|link>
```

- `query` accepts a `query` string with optional `mode: "query" | "search" | "vsearch"`; typed retrieval with `searches`, `vec`, or `hyde` and no `mode` or `query`; or explicit `observed` frontmatter filtering/discovery, which can omit query text. `mode` never combines with `searches`. Lexical retrieval does not require a valid contract or an embedding provider.
- `context` retrieves the declared search context.
- `templates` lists the templates in the vault's template folder and their declared axes, or shows one template.
- `index-status` requires `view: "status" | "collections" | "contexts"`.
- `get-document` requires exactly one of `target`, `targets`, or `notePath` with its window.
- `link` suggests `[[wikilinks]]` for one note (`notePath`, optional `folder`). Suggestions are anchored to a term note's basename or alias, cover the first occurrence of each target only, and report an ambiguous span instead of resolving it. `oms search --link <path>` is the CLI counterpart.

A link suggestion is not consent, and search has no apply operation. Show the candidates and insert only the links the user accepts, with the host's file tools at the reported span; if the note changed since, suggest again. Save the note through MCP `write` so the contract judges it, then check it with `doctor { op: "link-check", notePath }`.

Template source files are never returned as notes. Expansion is explicit only for `search { op: "query" }` through its closed strategy object and never changes a plain lexical query. Folder meanings from the sealed folder contract come back as `folderIntents`.

Typed queries intersect these axes:

- `axes.template` selects one template from the template folder.
- `axes.field.<key>` filters a field declared by that template; values may be scalars, scalar lists, or supported predicate objects.
- `axes.folder` scopes physical placement.
- `axes.link` follows observed wikilinks.

## Observed frontmatter

Use the separate `observed` namespace when the requested filter or exploration means values actually present in current notes, including unsealed or undeclared fields. Observation does not declare a field. `templates` is optional and is useful when declared-axis semantics are needed; it is not a prerequisite for observed discovery.

1. Page keys with `search {op: "query", observed: {discover: {limit: 20}}, limit: 0}`.
2. Page values for one returned key with `observed: {discover: {key: "subject", limit: 20}}`. Continue with `observed.discover.cursor`; this is separate from the note-hit cursor. Restart discovery if source changes invalidate the cursor.
3. Apply the chosen value facet's `selection` under `observed.field[<key>]` while retaining the discovery request's lexical query, collection and existing predicates. Merge it with a same-key range/membership predicate rather than replacing that predicate. For example, keep `score: {gte: 10, ...facet.selection}` when the facet was discovered under `score: {gte: 10}`. A string facet can return `selection: {exact: {valueType: "string", value: "science"}}`; exact date selections carry canonical ISO strings. Selection identifies a typed canonical value, not the entire query scope. Its count and note set are reproducible with unchanged sources and scope, before result caps or score/rerank filters. Replacing an existing predicate (including a previous exact selection) deliberately changes scope and may change the count; constructing equality from display text can also conflate date-looking strings and numeric timestamps.
4. Changing or adding lexical query text changes the scope. Keep `limit: 0` for discovery without note hits. Discovery-only responses use `facets: []` for the legacy facet field. Discovery pages are bounded by both item count and serialized bytes; follow the cursor and respect the explicit oversized-entry `omittedCount` rather than treating a short page as the whole vocabulary.

Observed filtering/discovery supports lexical and metadata-only requests. Do not combine it with vector, HyDE, or expansion. Scope discovery to a single `collectionPath`, not multi-collection aggregation. Use `axes.field` only for declared typed semantics; use `observed.field` deliberately rather than guessing a declaration or triggering repair.

A typed axis fails loudly on an undeclared field. Remove the typed axis rather than guessing a field. That failure does not stop lexical retrieval. Vector or HyDE retrieval fails loudly without a configured embedding provider and model. ADR-005 applies: do not hide a provider or backend failure as an empty success, a fake embedder, or another backend. Missing results are unobserved, not proof of absence.

Search never creates `.oms` or mutates templates, notes, the contract, or persistent indexes. Live lexical reads may refresh private detached session caches and disposable temporary storage. A successful validated detached result, including `indexDrift: false`, does not certify that the untouched persistent/vector index was synchronized. Warm-session speed does not imply the same latency for a new standalone CLI invocation. A search call does not grant edit rights.

The surface is four MCP tools (write, search, interview, doctor) and six skills.
