## engine

This is the R18 parallel retrieval engine being built alongside the live `src/search/` module. The swap from `src/search/` to `src/engine/` happens in M5 once all golden-set benchmarks pass; until then `src/search/` remains the regression floor and must not be modified. All new retrieval code lives exclusively under this directory, organised into three sub-modules: `embed/` (chunking + embeddings), `graph/` (link graph), and `retrieval/` (hybrid fusion pipeline). Shared interface contracts are exported from `types.ts` and re-exported through `index.ts`.
