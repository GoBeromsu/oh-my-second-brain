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

Axes intersect. They require current authority and fail loudly on an undeclared field or stale signature; remove the typed axis or run template diagnosis rather than guessing. Vector or HyDE retrieval also fails loudly without a configured embedding provider and model. Missing results and history are unobserved, not proof of absence or non-use.

## Template-change notices

Search is read-only, including census and notice handling. A result may carry a
machine `templateNotice` for a selected-folder source change. Surface the first
notice exactly as `템플릿에 변경이 있습니다` with exactly `확인하기` and
`나중에`; do not render a template name, hash, or change taxonomy. This
requirement applies to long-lived sessions even when boot instructions are
stale. `status` returns the full notice on every poll; `search` emits it once
per process and pending digest, and again when that digest changes.

`나중에` is host-only: it performs no server call and does not mutate the
interview ledger. `확인하기` starts the linear interview with
`write { op: "template", mode: "interview-next" }`. Answers use
`interview-answer` and the server-returned question, request, and CAS values;
resume from the server-returned next question rather than inventing fields.
Unchanged confirmed answers are preserved. A zero-question response proceeds to
final confirmation, and `commit-contracts` is sent only after the user approves
the exact final digest; never self-approve.

The surface remains five MCP tools and seven skills. Search never mutates
templates, notes, controls, or the interview ledger.
