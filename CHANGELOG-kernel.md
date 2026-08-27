# Kernel Changelog

Domain logic changes belong here.

## [Unreleased]

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
