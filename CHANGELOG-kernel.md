# Kernel Changelog

Domain logic changes belong here.

## [Unreleased]

### Added

- A `SearchBackend` seam names the retrieval capability OMS actually ships, so a second backend has something to implement against instead of reaching into the engine's own types. A request is either a plain `query` or typed `searches` sub-queries — never both — plus `limit`, `minScore`, and an `intent` field that disambiguates without itself searching. That exclusive choice is enforced at runtime as well as in the type, because a request parsed from JSON at the MCP boundary arrives unchecked.
- A conformance suite defines what "a search backend" means. A new backend implements the interface and must pass `src/kernel/searchbackend/conformance.test.ts`; anything that can't is not a backend.

### Changed

- The in-repo engine is the **default** search backend. qmd is pluggable, neither default nor required, and no dependency was added or removed to make the seam exist — a third-party binary is never mandatory for a core capability.
- A plain `query` expands to lexical search only. Expanding it to lexical + vector was tried and rejected: on a vault with no embeddings that converts a perfectly good lexical answer into a loud failure. Asking for `vec` explicitly still fails loudly with `available: false` naming `OMS_EMBEDDING_PROVIDER` and `OMS_EMBEDDING_MODEL`, which is ADR-007 behaving exactly as locked.
- **Breaking:** every domain module now lives under `src/kernel/`, and `src/index.ts` moved with it. The package `main` and `types` are now `dist/kernel/index.js` and `dist/kernel/index.d.ts`. Importing the package by name is unaffected; anything reaching into a deep `dist/` path must update, since the package publishes no `exports` map to shield those paths.
- **Breaking:** `retrieve/` is now `kernel/search/`, matching the `search` skill and the `oms_search` tool that already carried that name.
- ADR-009 is superseded only in part. D2, the qmd-compatible surface as a product interface, is retired. D1, link-based `resolveEffectiveVault`, remains in force and is load-bearing for the verified-target write kernel — marking the whole ADR dead would have silently retired a live contract.
