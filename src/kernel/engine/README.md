## engine

The native OMS retrieval engine. It is the single semantic backend after the
legacy `src/search/` layer was retired (the #34 follow-up teardown). All
retrieval code lives under this directory, organised into sub-modules: `embed/`
(chunking + embeddings + the sqlite-vec store), `graph/` (link graph), and
`retrieval/` (hybrid fusion pipeline). Shared interface contracts are exported
from `types.ts`. Embedding selection is
explicit via `OMS_EMBEDDING_PROVIDER` + `OMS_EMBEDDING_MODEL` (ADR-007): there is
no fake/hash fallback, no provider auto-detect, and no `OMS_MODEL_PATH` alias.

When those embedding settings are absent and no setup-installed default is
available, the core assembly remains usable for lexical-only retrieval.
Vector/HyDE requests return `available: false` with guidance naming both
`OMS_EMBEDDING_PROVIDER` and `OMS_EMBEDDING_MODEL`; they never fabricate
vectors or download a model as a side effect. The resolver may consume a
setup-written installed-default descriptor, but that descriptor points to a
real model and is not provider auto-detection or a fake fallback. The canonical
environment pair remains the explicit way to select that model.

Cross-encoder reranking is opt-in (`rerank: true`) and default-off. The native
`LlamaRankingContext` is created lazily only after a rerank request, receives at
most 50 candidates by default, and is retained until an explicit idle-unload
timeout is configured. Constructing an engine or serving lexical queries does
not load reranker model state.
