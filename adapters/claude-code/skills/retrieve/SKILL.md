---
name: oms-retrieve
description: Retrieve knowledge from the vault through declared Oh My Second Brain retrieval views and axes (agent-guided; runtime is roadmap).
---

# Skill: oms-retrieve (Claude Code)

Surface the right notes and fields for a given purpose using the vault's declared retrieval axes and views (인출).

## Invocation

```
/oms-retrieve
```

## What this skill does

Conceptually shells out to:

```bash
oms retrieve
```

**Runtime note:** Retrieval is available through MCP tools. Prefer
`oms_retrieve_context` for live graph + semantic context retrieval, use
`oms_sync_embeddings` when the native semantic index must be refreshed, then
`oms_get_document` or `oms_multi_get_documents` for selected semantic evidence
or `oms_semantic_query`/`oms_semantic_status` for qmd-compatible follow-ups,
and `oms_lazy_load_note` for selected vault-note bodies. `oms_retrieve_by_axis`
remains available for legacy cache-backed axis retrieval.

## Typed query interface

Pass `semanticSearches` to issue typed sub-queries in a single call:

| type    | behaviour                                        |
|---------|--------------------------------------------------|
| `lex`   | BM25 keyword search (exact terms, fast)          |
| `vec`   | SQLite-vector semantic search (meaning-based)    |
| `hyde`  | Hypothetical-document expansion before search    |
| `graph` | Semantic candidates confined to graph neighbors  |

```
semanticSearches: [
  { type: "lex",   query: "transformer attention" },
  { type: "vec",   query: "self-attention replaces recurrence" },
  { type: "hyde",  query: "a paper about attention mechanisms" },
  { type: "graph", query: "related concepts in my notes" }
]
```

Use `semanticScope: "global"` (default) for vault-wide semantic search.
Use `semanticScope: "graph"` (**gph mode**) to confine semantic candidates
to the set already selected by the OMS graph traversal.

## Agent-guided steps (v0)

1. Clarify the user's **retrieval purpose** (synthesize, audit, plan, review, etc.).
2. Narrow by declared **folder/concept/property/wikilink axes** where possible.
3. Match the purpose to a declared **retrieval view** (`lenses` in YAML) in `vault/.oms/concepts/*.yaml`.
4. Call MCP `oms_retrieve_context` with the best available axes and query.
5. Choose semantic scope: `semanticScope: "global"` for broad vault-wide search;
   `semanticScope: "graph"` (gph mode) when candidates must stay inside the
   selected graph neighbors. Pass typed sub-queries via `semanticSearches`
   using `lex`, `vec`, `hyde`, or `graph` types as appropriate.
   Pass `semanticMode`, `semanticIntent`, `semanticLex`, `semanticVec`,
   `semanticHyde`, and `semanticMinScore` for additional control.
   Use `semanticStorage: "qmd-sqlite"` for the default qmd-compatible SQLite
   store; set `embeddingSyncBeforeSearch: true` only when the native semantic
   index must be refreshed before retrieval.
6. Use `oms_sync_embeddings` for explicit update/embed sync.
7. Use `oms_semantic_query`, `oms_semantic_status`, `oms_semantic_collections`,
   or `oms_semantic_contexts` for qmd-compatible follow-ups on the native OMS index.
8. Use read-only `oms_get_document` or `oms_multi_get_documents` to rehydrate
   selected docids, paths, globs, or line ranges.
9. For each note, return the retrieval-view fields and lazy-load body only when needed.
10. Return results grouped by concept/folder with retrieval-view frontmatter.

## Example

```
Purpose: "Synthesize my transformer papers"

→ concept: literature
→ view:    synthesis  (YAML key: lenses; fields: [title, thesis, source-url])
→ scan:    vault/references/*.md
→ output:

| title | thesis | source-url |
|-------|--------|------------|
| Attention Is All You Need | Self-attention replaces recurrence | https://arxiv.org/abs/1706.03762 |
```

## Runtime

Use MCP `oms_retrieve_context` for live graph/semantic retrieval. Pass typed
sub-queries via `semanticSearches` (types: `lex`, `vec`, `hyde`, `graph`).
Use `semanticScope: "graph"` (gph mode) to confine semantic candidates to
graph neighbors. Use MCP `oms_sync_embeddings` for native semantic-index sync.
Use MCP `oms_get_document` or `oms_multi_get_documents` for document rehydration.
Use MCP `oms_retrieve_by_axis` only for legacy axis-first cache retrieval.
Use MCP `oms_lazy_load_note` only after selecting candidate notes.
