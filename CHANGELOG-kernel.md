# Kernel Changelog

Domain logic changes belong here.

## [Unreleased]

### Added

- **Explicit qmd-profile query expansion is now a real kernel capability.** `strategy: { kind: "expand", profile: "qmd-v2.8.3" }` lazily invokes the configured generate model, validates a closed `lex`/`vec`/`hyde` plan, rejects malformed, duplicate, over-budget, and identity-only output, then routes the plan through native retrieval. Plain queries remain lexical-only, and reranking remains an independent opt-in.
- **The active taxonomy now supplies model context without a second context store.** Folder `intent` values are projected only from `<vault>/.oms/taxonomy.yaml` into expansion and reranking prompts. Query receipts and semantic status record exact source provenance plus deterministic warnings for indexed folders without intent and taxonomy folders without indexed Markdown; semantic context listing exposes the same projection.
- **OMS now reads a strict, portable `models.json` v1 descriptor and records verified model acquisition.** Installed model artifacts are accepted only after their declared identity is verified, and the resulting receipt records the installed model rather than relying on an ambient local path.
- **Shipped Qwen and EmbeddingGemma descriptors now declare their named embedding prompts.** The prompt identity is part of the model contract instead of an implicit provider default.

### Changed

- **Expanded HyDE text is embedded once, matching qmd's typed-plan semantics.** A `hyde:` line emitted by query expansion is already a hypothetical document; it no longer triggers a second generation call. User-authored explicit HyDE still generates a hypothetical document and fails loudly when generation or embedding is unavailable.
- **Local model registration now canonicalizes the real file target and keeps it outside the vault.** Regular files are verified by checksum at setup and resolution time; vault-internal paths and symlink targets are rejected so model weights cannot pollute the user-owned Markdown corpus.
- **The derived SQLite store now has one canonical production location: `<vault>/.oms/engine-store.sqlite`.** All production defaults resolve it through the kernel path owner. There is no migration, dual-read, or compatibility alias; run `oms embed` to rebuild an existing derived store when necessary.
- **Rerankers are now lazy, assembly-owned capabilities.** A configured reranker is created only when requested, is available through the assembled kernel, and is disposed with that assembly.
- **An unconfigured capability now names the command that actually installs it.** The guidance for a vault with no model previously named only the environment pair, so a new user was told what to configure but not how to obtain a model at all. Each capability now names its own remedy: `embed` points at `oms setup --models-default`, because that is the one pinned model a single command can install, while `rerank` and `generate` point at `oms setup --models-descriptor <path>`, because no default exists for them and naming the pinned flag would promise an install that never happens.

### Breaking

- **Embedding identity metadata is now revision/checksum format v3.** Existing vectors are not migrated or trusted under the new identity: run `oms embed` to re-embed them. No migration or compatibility path is provided.
- **The passthrough reranker is no longer part of the production retrieval surface.** `PassthroughReranker` and `passthroughReranker` were exported from `src/kernel/engine/retrieval/` as the "default no-op reranker", and because reranking availability is decided by whether a reranker is defined at all, injecting that no-op made an explicit `rerank: true` request report **success** while returning the unchanged fused order. A caller asking for cross-encoder precision was told it happened when it had not. Reranking stays opt-in (ADR-011) and the correct production state for an unconfigured reranker is now absent rather than inert, so such a request fails loudly with its configuration remedy. The inert implementation remains available to tests at `retrieval/passthrough.test-helper.ts`, and a new architecture gate (`test/architecture/test-helper-isolation.test.ts`) enforces that no production module imports a `*.test-helper.ts`, which was previously only a comment.
- **An explicit HyDE request no longer degrades into an ordinary vector search.** HyDE shipped with an identity stub as its default generator, so a request for hypothetical-document retrieval quietly embedded the raw query instead and still reported itself as HyDE — the caller asked for a capability the engine did not have and was handed something else without being told, which is exactly the substitution ADR-007 forbids. There is now no default generator: an absent one fails and names both capabilities HyDE actually needs, a generate model to write the hypothetical document and an embed model to embed it. Generator output that is empty, or that merely echoes the query, is rejected for the same reason rather than embedded. This removes the fake fallback; it does not add real HyDE generation, which remains unavailable until a generation model is configured.

### Fixed

- **Generation teardown no longer races a native prompt.** The generator now awaits `session.prompt()`, disposes the async sequence before its parent context, blocks new calls during teardown, and waits for every admitted HyDE/expansion call before disposing the shared model. This removes a reproducible `DisposedError` followed by a Metal `GGML_ASSERT` process abort.
- **Plain SearchBackend requests no longer synthesize and forward both `query` and `searches`.** They preserve the public XOR contract and remain lexical-only regardless of installed models; explicit typed searches and expansion are forwarded through their own representations.
- **A refused reranking request now tells the user how to enable it.** The refusal named only `assembleEngine()` and `createOMSMcpServer()`, which is actionable for someone editing the source and useless to anyone driving OMS through the CLI or an MCP client: it never mentioned `OMS_RERANK_PROVIDER`/`OMS_RERANK_MODEL`, `.oms/models.json`, or the setup command that installs a reranker. It now emits the same capability-specific remedy the model resolver produces, from one shared `capabilityGuidance()` helper so the two cannot drift apart, and still mentions programmatic injection for callers who want it. The guidance names the rerank capability only — pointing at the embed pair would send someone to install a model that does not enable reranking at all.
- **The provider factory's unconfigured-model errors now carry the full remedy, which matters most on the MCP surface.** `requireRealEmbeddingProvider` threw messages naming only `OMS_EMBEDDING_PROVIDER`/`OMS_EMBEDDING_MODEL`, and those strings reach an MCP client verbatim — so an AI agent asking for vector retrieval on an unconfigured vault was told one of the three ways to configure a model and never learned that `.oms/models.json` or `oms setup --models-default` existed. Both branches now emit the shared capability guidance, and the supported-provider hint is kept because the shared text says where to set a provider but not which values are valid. The MCP test that covered this was itself too weak to catch it: `/OMS_EMBEDDING_PROVIDER|OMS_EMBEDDING_MODEL/` is an alternation that passes when only one appears, so it now asserts each element of the contract separately and additionally rejects the rerank or generate remedies appearing on an embed refusal.
- **`oms embed` now tells you how to configure a model instead of only that one is missing.** With no embedding model configured it answered `Embedding provider is required.` and stopped there — stating the problem while withholding every remedy, on the one command whose whole job is building the index and therefore the most likely place a user first discovers the gap. It now appends the same capability guidance the other surfaces emit: the exact environment pair, `.oms/models.json`, and `oms setup --models-default`. The guidance is attached to the provider and model fields only; a missing revision, checksum, or prompt scheme still reports plainly, because that means an incomplete descriptor rather than an unconfigured capability, and pointing at the environment pair there would send the reader to fix something already set.
- **A model-less vault is no longer told it is running a graph-only engine it never asked for.** Running `oms semantic vsearch` on an ordinary vault with no embedding model configured returned `graph-only engine: embedding provider unavailable…`, because the deferred provider hardcoded that phrase into its message. That provider is wired by the core, ephemeral, and read-only assemblies as well as the graph-only one, so the text misreported which engine was actually running — a guard that misdescribes the runtime it guards is its own kind of dishonest output. The message now states only what is true: the embedding provider is unavailable, plus the configuration remedy. The store guard still names the graph-only engine, because `assembleGraphOnlyEngine` is genuinely its only caller.
- **The graph-only engine's embedding guard now names every way to configure embeddings.** Its refusal listed the environment pair alone, which is two of the three routes: it never mentioned `.oms/models.json` or the one-step `oms setup --models-default` install, so a user with no variables set was not told the simplest remedy existed. It now emits the shared capability guidance and still names the provider credential a remote provider needs.

## [0.8.4] - 2026-08-30

## [0.8.3] - 2026-08-29

## [0.8.2] - 2026-08-29

## [0.8.1] - 2026-08-29

### Fixed

- **Frontmatter YAML comments and fenced-code headings are no longer mistaken for a document title.** `documentTitle` fell back to scanning the raw document for the first ATX H1, which reads the frontmatter block too — where a YAML comment (`# rewrite this later`) is byte-identical to an H1. The same unguarded regex matched an `# heading` inside a fenced code block, so a note demonstrating markdown was titled by its own example. Because the title is prepended to *every* chunk's embedding input, one wrong title skews the vectors for the whole note, not just the chunk containing that line. The H1 scan is now confined to `parsed.body` and tracks backtick and tilde fences, closing a fence only on a run at least as long as the opener per CommonMark. A document whose frontmatter fence never closes has an empty body and is therefore untitled, which is the honest answer for a malformed document rather than a guess drawn from non-body text.

  This is a title-selection fix, not a redaction: `chunkDocument` receives the raw document, so frontmatter text was and remains part of the indexed chunk text. The bug was which text got treated as the title.
- **The chunk digest can no longer be made to collide across the title boundary.** The digest joined title and text with a bare NUL separator and claimed that made the pair unambiguous. Nothing forbids a NUL in note text, so `("a", "\0b")` and `("a\0", "b")` hashed identically — meaning a crafted retitle could impersonate a body edit and suppress re-embedding. The title is now length-prefixed, making the encoding injective for every input. **This changes the digest formula again, so the first `oms embed` after upgrading re-embeds once**, on top of 0.8.0's own one-time reindex.
- **A `NaN` vector-query width is rejected instead of silently becoming the widest possible scan.** `clampVecK` treated every non-finite value alike via `!Number.isFinite(k)`, so `NaN` and `-Infinity` both saturated to the 4096 ceiling. For `NaN` that ran the most expensive ANN scan available and then returned nothing, because the subsequent `.slice(0, NaN)` yields an empty array — hiding a caller bug behind an empty page. `NaN` now throws, matching how `vecBuf` rejects a non-finite vector component; `Infinity` still saturates, since it is the honest spelling of "every candidate"; and a negative or zero request still floors to 1.

## [0.8.0] - 2026-08-29

### Added

- **A pinned default embedding model is now available for explicit one-step install.** `PINNED_DEFAULT_EMBEDDING_MODEL` describes EmbeddingGemma-300M (`embeddinggemma-300M-Q8_0.gguf`, 768d, 2048-token context) with its source URL and a verified SHA-256 of `b5ce9d77…90d63`. This is the same model qmd resolves from its own `DEFAULT_EMBED_MODEL_URI`, so a vault indexed by `oms embed` gets that toolchain's retrieval quality instead of a lesser stand-in. The constant is deliberately **not** a fallback: `resolveEmbeddingModel` never reaches for it, because an implicit default would defeat the E-1 no-default contract, which verifies at runtime that embedding capability stays honestly unavailable with no environment pair and an empty cache. Its only consumer is the explicit setup acquisition path, which verifies the downloaded bytes against the pinned digest before publishing them. ADR-007 P-B is unaffected — a real, explicitly installed model was never the fake fallback that principle forbids.
- **Chunks now carry their document title into the embedding input.** `Chunk.title` is resolved from frontmatter `title`, then the first ATX H1, then the literal `none`, and `EmbeddingProvider.embed(text, title?)` accepts it. A passage prefix may declare a `{title}` slot, which the GGUF and Upstage providers substitute per chunk; the pinned descriptor uses `title: {title} | text: `, reproducing qmd's `formatDocForEmbedding` byte-for-byte. This matters for retrieval rather than cosmetics: a chunk from the middle of a note is frequently ambiguous on its own, and the document title is the cheapest available disambiguating context. A prefix without the slot is prepended exactly as before, so every existing descriptor keeps its current behavior.

### Changed

- **Chunk change-detection digests now cover the document title as well as the chunk text.** The title reaches every chunk's embedding input, so a digest over text alone reported "unchanged" for each chunk that did not itself contain the title line — leaving stored vectors that still encoded the *old* title after a retitle. The digest is now taken over title and text with a NUL separator, so no retitle can collide with a body edit. The cost is explicit: because the digest formula changed, the first `oms embed` after upgrading re-embeds every chunk once. We chose that over making the digest conditional on provider configuration, which would have coupled chunking to embedding settings and left the stale-vector bug reachable.

### Fixed

- **Vector queries no longer fail outright on an unbounded candidate limit.** Without an explicit `candidateLimit`, the MCP facade requests `Number.MAX_SAFE_INTEGER` candidates so it retrieves the complete ranked stream and keeps `totalCount` and offset cursors accurate past the first page. FTS tolerates that, but sqlite-vec rejects any knn `k` above its own 4096 ceiling, so every vector and HyDE query failed with `k value in knn query too large`. The collection-scoped branch had the same defect from the opposite direction: it passed the *total* chunk count, which fails on any vault with more than 4096 chunks. The store — the only layer that knows the extension's constraint — now clamps `k` into the supported range, and a non-positive request collapses to 1 rather than 0 so a caller asking for "some" results never silently gets an empty page. This was unreachable in practice until now, because a vault with no embedding model never got as far as a vector query; configuring a local model exposed it immediately.

  The clamp is a genuine ceiling, not a cure-all, and it moves the cost rather than removing it. In a vault with more than 4096 chunks the vector candidate stream is truncated, so a vector-derived `totalCount` and any deep page beyond that band are bounded by it; a collection-scoped query is affected more sharply, because sqlite-vec ranks before the collection predicate is applied, so a collection whose chunks all fall outside the band can be starved. Both are properties of ANN-before-predicate search in sqlite-vec. The alternative was failing every vector query outright, which is what shipped before this clamp.

## [0.7.0] - 2026-08-27

### Breaking

- `resolveEffectiveVault` no longer consults `~/.oms/config.yaml`. The `"global"` member is removed from `VaultSource`, and the write kernel's `admitWriteTarget` drops the branch that trusted it. The remaining precedence is unchanged in relative order: `explicit` > local `.oms` vault ontology > bridge `links.yaml` > `OMS_VAULT`, falling back to `cwd` (unverified, writes rejected).
- `resolveEffectiveVault`'s `opts.homeDir` parameter is removed. It existed only so the deleted tier could read a config file from a caller-supplied home directory, and had no other consumer.

## [0.6.2] - 2026-08-27

### Fixed

- **`taxonomy.yaml: exclude` now applies to retrieval, not just linting.** The exclude list was parsed into the ontology and resolved into globs for the lint and setup lanes, but the three walkers behind search, axis observation, and graph caching never consulted it and each threw on the first note whose frontmatter would not parse as YAML. Declaring a template source in `exclude` — the documented remedy, and necessary because pre-substitution template frontmatter is intentionally not valid YAML — therefore had no effect on those lanes. All three now filter their yielded paths against the resolved exclude list before parsing, so an excluded file is skipped instead of aborting the scan. Because excluded files no longer contribute to the node-index source signature, the first run after upgrading rebuilds that cache once.
- **A frontmatter field set to an empty string no longer aborts the axis scan.** `field: ""` states that a field is declared but unset, which is what `field:` already meant; only the explicit empty string was fatal, because empty strings were rejected while `null` and `undefined` were skipped silently. Empty and whitespace-only strings are now skipped the same way. The non-empty invariant still holds for every value that is actually recorded.
- **Axis value errors now name the note that caused them.** A rejected value threw with no path attached, so a whole-vault scan failure gave no indication of which of thousands of notes was responsible. These errors are now prefixed with the note path and preserve the original error as `cause`.

## [0.6.1] - 2026-08-27

### Fixed

- Measurement environment variables now treat empty or whitespace-only values as unset. This preserves CI behavior when an unset GitHub Actions variable expands to an empty string, while non-empty malformed digests, attestations, arms, and other measurement values still fail loudly.

## [0.6.0] - 2026-08-27

### Changed

- The shipped ranking default remains the released v0.3.0 `boost-additive` baseline — RRF score plus provenance boost with no per-list reordering — instead of an unmeasured multiplicative boost. The frozen `boost-k-scale`, `boost-per-list`, and `boost-zero` arms remain experiments, so released ranking behavior stays evidence-backed and reproducible.
- The `boost-c040` measurement gate now applies only when a release changes the shipped ranking default from that baseline. Baseline releases pass with a receipt and need no manifest, while adopting an experiment arm still requires the real-vault signed manifest with no waiver; this targets the strict evidence requirement at the decision that can change user results.
- Default embedding-model acquisition is deferred to a later release. No real-vault `model-default` measurement exists, so the vault owner invoked the preregistered E-1 Rule 1 fallback when authorising this release: no new default embedding model ships here. Explicit `OMS_EMBEDDING_PROVIDER` / `OMS_EMBEDDING_MODEL` behavior is unchanged, and `oms setup --embedding-descriptor <path>` accepts an operator-supplied descriptor with SHA-256 verification. The no-default contract is machine-verified and fails closed: it checks at runtime that no default descriptor pointer is introduced, that the explicit environment pair resolves identically with and without the fallback while a half pair still fails loudly naming both variables, and that the fallback and MCP paths perform zero downloads. `boost-c040` remains a separate required, never-waivable measurement. Choosing a different model would be a contract change requiring replanning, and the deferral closes only with a validator-accepted, green `model-default` manifest from the real vault owner. The repository records that decision under `docs/measurements/`.

### Fixed

- `oms update` now compares versions with SemVer prerelease and build-metadata precedence instead of treating every dotted component as a number.
- Embedding reindexing now builds and validates a complete shadow generation before an atomic swap, with cross-process writer locking and crash-point recovery coverage; a failed rebuild preserves the active generation.
- Embedding model resolution now rejects half-configured environment pairs, verifies setup artifacts by SHA-256 outside the vault, and reports unavailable vector capability with actionable `OMS_EMBEDDING_PROVIDER` / `OMS_EMBEDDING_MODEL` guidance.
- Lex-only retrieval remains available without a configured embedding provider, while the opt-in reranker lazy-loads with a bounded candidate set and no fake model fallback.
- Added the JSON frontmatter contract and typed EAV axis store with read-only `.obsidian/types.json` authority; legacy YAML remains ignored and unknown contract properties are preserved.
- Search query envelopes now expose total counts, cursors, facets, intent metadata, and folder/field/link axis filtering with same-axis OR and cross-axis AND semantics.

## [0.3.0] - 2026-08-24

### Fixed

- Collection scoping now constrains the candidate set before result limiting. A filtered query previously ran against already-truncated results, so it could return nothing while matching in-collection documents sat below the limit.
- Collection names are matched literally. They were interpolated into a SQL `LIKE` pattern unescaped, so `_` and `%` acted as wildcards and a request for `my_notes` also matched `myXnotes`.

### Added

- A `SearchBackend` seam names the retrieval capability OMS actually ships, so a second backend has something to implement against instead of reaching into the engine's own types. A request is either a plain `query` or typed `searches` sub-queries — never both — plus `limit`, `minScore`, and an `intent` field that disambiguates without itself searching. That exclusive choice is enforced at runtime as well as in the type, because a request parsed from JSON at the MCP boundary arrives unchecked.
- A conformance suite defines what "a search backend" means. A new backend implements the interface and must pass `src/kernel/searchbackend/conformance.test.ts`; anything that can't is not a backend.

### Changed

- The in-repo engine is the **default** search backend. qmd is pluggable, neither default nor required, and no dependency was added or removed to make the seam exist — a third-party binary is never mandatory for a core capability.
- A plain `query` expands to lexical search only. Expanding it to lexical + vector was tried and rejected: on a vault with no embeddings that converts a perfectly good lexical answer into a loud failure. Asking for `vec` explicitly still fails loudly with `available: false` naming `OMS_EMBEDDING_PROVIDER` and `OMS_EMBEDDING_MODEL`, which is ADR-007 behaving exactly as locked.
- **Breaking:** every domain module now lives under `src/kernel/`, and `src/index.ts` moved with it. The package `main` and `types` are now `dist/kernel/index.js` and `dist/kernel/index.d.ts`. Importing the package by name is unaffected; anything reaching into a deep `dist/` path must update, since the package publishes no `exports` map to shield those paths.
- **Breaking:** `retrieve/` is now `kernel/search/`, matching the `search` skill and the `oms_search` tool that already carried that name.
- ADR-009 is superseded only in part. D2, the qmd-compatible surface as a product interface, is retired. D1, link-based `resolveEffectiveVault`, remains in force and is load-bearing for the verified-target write kernel — marking the whole ADR dead would have silently retired a live contract.
