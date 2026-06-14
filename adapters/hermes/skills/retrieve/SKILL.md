---
name: retrieve
description: Retrieve vault knowledge axis-first using folders, frontmatter, wikilinks, and declared lenses.
---

# oms-retrieve

Use `oms_retrieve_context` first for natural-language retrieval. It combines live
frontmatter/folder/wikilink graph context with optional OMS native semantic
lexical/SQLite-vector/HYDE candidates and does not require a warm graph cache. Pass declared
concept/folder/property/value/wikilink axes when the user's intent gives them.

Use `semanticScope: "global"` for broad vault-wide semantic search. Use
`semanticScope: "graph"` (**gph mode**) when semantic candidates must stay inside
the selected OMS graph candidates.

Pass typed sub-queries via `semanticSearches` to combine search strategies in one call:
`type: "lex"` for BM25 keyword search, `type: "vec"` for SQLite-vector semantic
search, `type: "hyde"` for hypothetical-document expansion, and `type: "graph"` for
semantic candidates confined to graph neighbors. Pass `semanticMode`, `semanticIntent`,
`semanticLex`, `semanticVec`, `semanticHyde`, and `semanticMinScore` for additional
typed or thresholded control. Pass `semanticStorage: "qmd-sqlite"` for the default
qmd-compatible SQLite store, and `embeddingSyncBeforeSearch: true` when the native
semantic index must be refreshed before retrieval, or call `oms_sync_embeddings` explicitly.
Use read-only `oms_get_document` or `oms_multi_get_documents` to rehydrate selected
docids, paths, globs, or line ranges. Use `oms_semantic_query`,
`oms_semantic_status`, `oms_semantic_collections`, or `oms_semantic_contexts` for
qmd-compatible follow-ups on the native OMS index.

Use `oms_retrieve_by_axis` only for legacy axis-first cache retrieval. Use
`oms_lazy_load_note` only after selecting candidate notes.

Return lens-shaped fields where possible; do not dump full note bodies unless the user asks or the retrieval task needs body evidence.
