# MCP Changelog

MCP server tools and resources belong here.

## [Unreleased]

### Changed

- `oms_search` advertises `limit` (default 10), `minScore` (default 0) and `rerank` (default false). The first two are applied at the normalizer, so an options-free query is bounded rather than unlimited. `rerank` is opt-in per ADR-011: `true` reranks only when startup was given a real reranker and otherwise fails loudly with configuration guidance, rather than silently returning unreranked results as if the request had been honoured.

- The public MCP surface is now five tools — `oms_write`, `oms_search`, `oms_link`, `oms_status`, `oms_doctor` — down from twenty-three. The eighteen detail tools are reachable through an `op` parameter on the tool that owns them; nothing was deleted, so no capability is lost, but any client calling a detail tool by its old name must switch to the owning tool plus `op`.
- `oms_search` routes through the `SearchBackend` seam. A plain `query` now expands to lexical retrieval and returns results on a vault with no embedding provider, where it previously failed. Asking explicitly for vector retrieval — through a typed `vec` or `hyde` sub-search, the `vec`/`hyde` shorthands, or `mode: "vsearch"` — still fails loudly naming `OMS_EMBEDDING_PROVIDER` and `OMS_EMBEDDING_MODEL`. Lexical is a default for callers who did not choose a strategy, never a substitute for one that was asked for.
- Supplying an explicit `mode` together with explicit `searches` is refused as contradictory rather than resolved by discarding one of them.
- `oms_write` refuses a request that addresses the note both ways at once. `notePath` and `folder`/`filename` are alternatives; supplying both used to write one form while reporting the other's implications.
- Every mutating `oms_doctor` repair returns a typed receipt whose postcondition the server verified by reading persisted state back. Repairs are admitted through the verified-target kernel before anything touches disk, so a `cwd`-inferred target is rejected while diagnosis still works.

### Removed

- The qmd-compatible aliases `query`, `get`, `multi_get` and `status`, and the `qmd://` resource, are gone. ADR-009's D2 is superseded by ADR-010; D1 remains in force.
