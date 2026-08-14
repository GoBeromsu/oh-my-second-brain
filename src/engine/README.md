## engine

The native OMS retrieval engine. It is the single semantic backend after the
legacy `src/search/` layer was retired (the #34 follow-up teardown). All
retrieval code lives under this directory, organised into sub-modules: `embed/`
(chunking + embeddings + the sqlite-vec store), `graph/` (link graph), and
`retrieval/` (hybrid fusion pipeline). Shared interface contracts are exported
from `types.ts`. Embedding selection is
explicit via `OMS_EMBEDDING_PROVIDER` + `OMS_EMBEDDING_MODEL` (ADR-007): there is
no fake/hash fallback, no provider auto-detect, and no `OMS_MODEL_PATH` alias.
