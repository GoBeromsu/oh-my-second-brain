---
name: retrieve
description: Retrieve knowledge from the vault through declared Oh My Second Brain lenses (인출).
---

# Skill: retrieve

Surface the right notes and fields for a given purpose using the vault's
declared retrieval lenses.

## What this skill does

1. Identify the **retrieval purpose** from the user's request (e.g. "synthesize this topic", "audit my sources").
2. Match the purpose to a declared **lens** (e.g. `synthesis`, `audit`) on the relevant concept.
3. For each matching note, return only the fields listed in that lens — not all frontmatter.
4. Present results grouped by concept/folder with lens-filtered frontmatter.

## Lenses (인출 뷰)

A lens is a pre-declared named retrieval view, not a query filter.
Each concept declares which fields matter for which purpose:

```yaml
lenses:
  - name: synthesis
    intent: "Surface what was argued and where to find it"
    fields: [title, thesis, source-url]
  - name: audit
    intent: "Check provenance and capture date"
    fields: [title, source-url, captured-at]
```

The retrieval skill reads these declarations from `vault/.oms/concepts/*.yaml`.

## Engine

Use MCP `oms_retrieve_context` first for natural-language retrieval. It combines:

- live folder/frontmatter/wikilink graph exploration without requiring a warm cache
- taxonomy-axis seeds from concept, folder, property, value, or wikilink inputs
- graph neighbors through shared frontmatter values, wikilinks, and backlinks
- optional OMS native semantic lexical, SQLite-vector, and HYDE candidates when the semantic index is available

Use `semanticScope: "global"` for broad semantic search across the vault. Use
`semanticScope: "graph"` when semantic candidates must stay inside the selected
OMS graph candidates. The semantic provider is fail-soft: retrieval must still
return OMS graph hits when the native semantic index is unavailable or disabled.

For semantic retrieval, keep semantic-index and search controls on the OMS retrieve surface:

- pass `semanticMode: "query" | "search" | "vsearch"` to choose hybrid, lexical, or vector search
- pass `semanticIntent`, `semanticLex`, `semanticVec`, `semanticHyde`, or `semanticSearches` for typed query documents
- pass `semanticMinScore`, `semanticAll`, `semanticFull`, `semanticLineNumbers`, or `semanticFullPath` when the retrieval task needs search flags
- pass `semanticStorage: "qmd-sqlite"` for the default qmd-compatible SQLite store, or `semanticStorage: "oms-native-json"` only for the legacy JSON fallback
- pass `embeddingSyncBeforeSearch: true` when the native semantic index must be fresh before retrieval
- use `oms_sync_embeddings` for an explicit semantic-index sync without doing a retrieval query
- use `oms_semantic_query`, `oms_semantic_status`, `oms_semantic_collections`, and `oms_semantic_contexts` for qmd-compatible semantic follow-ups on the native OMS index
- use read-only `oms_get_document` or `oms_multi_get_documents` to rehydrate selected docids, paths, globs, or line ranges

Use the older MCP tools only for narrower follow-up steps:

- **`oms_retrieve_by_axis`** — legacy cache-backed axis retrieval by concept, folder, property, value, or wikilink.
- **`oms_lazy_load_note`** — fetches the full body of a single selected note on demand, avoiding loading all note bodies upfront.

## Example agent steps

```
User: "Synthesize my literature notes on transformers"

1. purpose  = synthesis
2. concept  = literature  →  lens = synthesis  →  fields = [title, thesis, source-url]
3. scan     = vault/references/*.md
4. for each note: extract only those three frontmatter fields
5. return a grouped summary with citations
```

## Persona

Use the **retriever** agent persona for this skill (`core/agents/retriever.md`).
