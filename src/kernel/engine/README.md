## engine

The native OMS retrieval engine. It is the single semantic backend after the
legacy `src/search/` layer was retired (the #34 follow-up teardown). All
retrieval code lives under this directory, organised into sub-modules: `embed/`
(chunking + embeddings + the sqlite-vec store), `graph/` (link graph), and
`retrieval/` (hybrid fusion pipeline). Shared interface contracts are exported
from `types.ts`.

Model selection is explicit and ordered per capability (ADR-007,
[ADR-012](../../../docs/decisions/ADR-012-portable-model-contract-and-lifecycle.md)):
request override, then a complete environment pair, then `.oms/models.json`,
then a setup-installed default, then unavailable. There is no fake/hash
fallback, provider auto-detect, or `OMS_MODEL_PATH` alias. A malformed
higher-precedence source fails rather than falling through to a lower one, and
the runtime never downloads a model as a side effect — acquisition happens only
through `oms setup`, which records verified artifacts in an installed-models
receipt that the resolver reads.

Plain queries are lexical-only by default and need no model. Expansion
(`strategy: { kind: "expand", profile: "qmd-v2.8.3" }`) and reranking
(`rerank: true`) are explicit; omitting either never changes a plain lexical
query.

Unavailable capabilities fail loudly with their own environment pair,
`.oms/models.json` declaration, and a setup remedy:

- **Vector** needs a verified local-GGUF selection from the complete
  `OMS_EMBEDDING_PROVIDER`/`OMS_EMBEDDING_MODEL` pair, vault configuration, or
  setup default. Install the pinned default with `oms setup --models-default`,
  then build vectors with
  `oms embed [--collection <name>] [--index <path>] [--force]`.
- **HyDE** needs *two* — a generate model to write the hypothetical document and
  embed model to embed it: `OMS_GENERATE_PROVIDER` +
  `OMS_GENERATE_MODEL`, and the embed pair. Install a configured generator with
  `oms setup --models-descriptor <path>`; there is no default generator.
- **Expansion** is explicit:
  `strategy: { kind: "expand", profile: "qmd-v2.8.3" }`. It needs generate and
  embed capabilities and the same descriptor setup remedy; it validates only
  typed `lex`/`vec`/`hyde` lines and records the plan in the query receipt.
- **Reranking** is opt-in (`rerank: true`) and default-off. An unconfigured
  reranker needs `OMS_RERANK_PROVIDER` and `OMS_RERANK_MODEL`, or a descriptor
  installed with `oms setup --models-descriptor <path>`; it is absent rather than
  a passthrough when unconfigured.

Kernel assembly owns lazy construction of the production reranker: the native
`LlamaRankingContext` is created only after a rerank request, receives at most 50
candidates by default, is shared by concurrent first requests, and is disposed
exactly once with its assembly. Constructing an engine or serving lexical queries
loads no model state at all.

In 0.10.0, expansion and reranking receive folder context only from active
`.oms/taxonomy.yaml` `intent` values. No legacy root file, bundled default, or
parallel context database can enter a model prompt. Receipts and status expose
the exact matched intents and deterministic warnings for unmatched indexed or
taxonomy folders.
