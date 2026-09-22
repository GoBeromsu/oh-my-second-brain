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

Retrieve vault knowledge without changing the vault. Search does not depend on contract validity, note completeness, or status health. Unbound, invalid, and incomplete notes stay searchable. Do not add a passing-notes-only filter. Do not start validation, repair, a semantic judge, or `/interview`.

## Usage

```text
/search <query|context|template-scan|templates|index-status|get-document>
```

- `query` requires `mode: "query" | "search" | "vsearch"` and exactly one of `query` or `searches`. Plain `mode: "query"` is projection-independent lexical retrieval and remains available when no embedding provider is configured.
- `context` retrieves the declared search context.
- `template-scan` is a read-only census and pending view; it never registers or writes a source.
- `templates` lists templates when `templateId` is absent and shows one template when `templateId` is present.
- `index-status` requires `view: "status" | "collections" | "contexts"`.
- `get-document` requires exactly one of `target`, `targets`, or `notePath` with its window.

Do not use retired `lazy-load`, `multi-get-documents`, `collections`, `contexts`, or `status` search operations. Template-managed source files are never returned as notes. Expansion is explicit only for `search { op: "query" }` through its closed strategy object and never changes a plain lexical query.

Use `search { op: "templates" }` to list stable template IDs and declared axes, or add `templateId` to show exactly one. Typed queries use the same derived projection as writes:

- `axes.template` selects one stable template identity.
- `axes.field.<key>` filters a field declared by that template; values may be scalars, scalar lists, or supported predicate objects.
- `axes.folder` scopes physical placement.
- `axes.link` follows observed wikilinks.

Axes intersect. They require current authority and fail loudly on an undeclared field or stale signature. Remove the typed axis rather than guessing a field. That failure does not stop lexical retrieval and does not start doctor, repair, or interview. Vector or HyDE retrieval fails loudly without a configured embedding provider and model. ADR-007 still applies: do not hide a provider or backend failure as an empty success, a fake embedder, or another backend. Missing results and history are unobserved, not proof of absence or non-use.

Search never creates `.oms` and never mutates templates, notes, controls, indexes, or the interview ledger. Stale or mixed controls are not a search outage and not a repair trigger. A search call does not grant edit rights.

## Template-change notices

Search is read-only, including census and notice handling. A result may carry a machine `templateNotice` for a selected-folder source change. Surface the first notice exactly as `템플릿에 변경이 있습니다` with exactly `확인하기` and `나중에`; do not render a template name, hash, or change taxonomy. This requirement applies to long-lived sessions even when boot instructions are stale. `search` emits the notice once per process and pending digest, and again when that digest changes. `status` returns the full notice on every poll.

`나중에` is host-only: it performs no server call and does not mutate the interview ledger. `확인하기` offers `/interview` and does not write source bytes or block search. Do not run interview questions or `commit-contracts` here.

The surface is five MCP tools and eight skills.
