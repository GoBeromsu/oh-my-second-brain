## engine

The native OMS retrieval engine. It is the single semantic backend after the
legacy `src/search/` layer was retired (the #34 follow-up teardown). All
retrieval code lives under this directory, organised into sub-modules: `embed/`
(chunking + embeddings + the sqlite-vec store), `graph/` (link graph), and
`retrieval/` (hybrid fusion pipeline). Shared interface contracts are exported
from `types.ts`.

Model selection is explicit and ordered per capability (ADR-007, ADR-012):
request override, then a complete environment pair, then `.oms/models.json`, then
a setup-installed default, then unavailable. There is no fake/hash fallback, no
provider auto-detect, and no `OMS_MODEL_PATH` alias. A malformed
higher-precedence source fails rather than falling through to a lower one, and
the runtime never downloads a model as a side effect — acquisition happens only
through `oms setup`, which records verified artifacts in an installed-models
receipt that the resolver reads.

With no model configured the core assembly remains usable for lexical-only
retrieval, and each unavailable capability names its own remedy: its exact
environment pair, `.oms/models.json`, and the matching `oms setup` command.
Naming another capability's remedy would send a user to install a model that
cannot serve their request.

The three capabilities differ in what they require:

- **Vector** needs the embed capability.
- **HyDE** needs *two* — a generate model to write the hypothetical document and
  an embed model to embed it. There is deliberately no default generator. An
  identity stub once stood in, so an explicit HyDE request embedded the raw query
  and still reported itself as HyDE; that fallback is removed, and generator
  output that is empty or merely echoes the query is rejected rather than
  embedded.
- **Expansion** is explicit:
  `strategy: { kind: "expand", profile: "qmd-v2.8.3" }`. It needs generate and
  embed capabilities, validates only typed `lex`/`vec`/`hyde` lines, and records
  the plan in the query receipt. An expanded `hyde` line is already a generated
  hypothetical document and is embedded directly; only user-authored explicit
  HyDE invokes a second generation step. Omission never changes a plain query
  from lexical-only behavior.
- **Reranking** is opt-in (`rerank: true`) and default-off. An unconfigured
  reranker is *absent*, not inert: a passthrough that returned hits unchanged
  would let an explicit request report success while nothing was reranked, so the
  request fails loudly instead. The no-op implementation is test-only, and an
  architecture gate enforces that production never imports it.

Kernel assembly owns lazy construction of the production reranker: the native
`LlamaRankingContext` is created only after a rerank request, receives at most 50
candidates by default, is shared by concurrent first requests, and is disposed
exactly once with its assembly. Constructing an engine or serving lexical queries
loads no model state at all.

Expansion and reranking receive folder context only from active
`.oms/taxonomy.yaml` `intent` values. No legacy root file, bundled default, or
parallel context database can enter a model prompt. Receipts and status expose
the exact matched intents and deterministic warnings for unmatched indexed or
taxonomy folders.
