# MCP Changelog

MCP server tools and resources belong here.

## [Unreleased]

## [0.13.0] - 2026-09-05

### Added

- **`write { op: "template", mode: "register-existing" }` registers a template that already lives in your vault.** Point it at a vault-relative Markdown path with an explicit stable `templateId`, the contract you authored, and a naming rule; the server reads the file as the shape authority and derives every control and source signature itself, so you no longer hand-assemble four expected digests and re-send the template's own bytes to register a file that is already on disk. The dry-run → `approvalDigest` → apply contract and its CAS checks are unchanged, and the source template is verified in place — never copied, rewritten, moved, or renamed. Re-registering an identical binding is refused as `TEMPLATE_ALREADY_REGISTERED` rather than a bare identity collision.

### Changed

- **`status.writeTools` response values were renamed from `oms_write-*` to `write-*` with the capability-only tool surface.** Raw MCP clients that consume this diagnostic field must migrate those response strings alongside the five public tool names.
- **MCP local tool names are now capability-only.** The `oms` server advertises `write`, `search`, `link`, `status`, and `doctor`, so qualifying hosts display `oms_write`, `oms_search`, `oms_link`, `oms_status`, and `oms_doctor` rather than `oms_oms_*`. Raw MCP callers must migrate `oms_write` → `write`, `oms_search` → `search`, `oms_link` → `link`, `oms_status` → `status`, and `oms_doctor` → `doctor`.

## [0.12.2] - 2026-09-01

## [0.12.1] - 2026-09-01

## [0.12.0] - 2026-09-01

## [0.11.1] - 2026-09-01

## [0.11.0] - 2026-09-01

### Fixed

- **A missing or unknown `op` now names the supported operations.** (#65) Instead of a bare unknown-operation error, every public tool lists its supported operations in deterministic order; `oms_status` remains the only op-free direct route, and supplying an operation to it is rejected explicitly.

## [0.10.1] - 2026-09-01

## [0.10.0] - 2026-09-01

### Changed

- **`oms_search` query now accepts the closed `strategy`, `maxQueries`, `rerank`, and `candidateLimit` controls.** Query budgets are strict integers, expansion is not advertised on context retrieval, and these controls remain on the existing tool; no additional public search tool was added.

## [0.9.0] - 2026-08-31

### Changed

- **The five-tool MCP surface now uses stable templates for every note-shaped operation.** `oms_write` has strict create/append/update branches: create derives placement from `templateId`, while append/update resolve the persisted note identity; guarded template operations remain on the same tool. `oms_search` advertises template/field/folder/link axes; `oms_status` reports projection signatures; and `oms_doctor` adds template diagnosis, approved projection regeneration, and exact one-note backfill without adding public tools.
- **Graph, link, and search paths share one resolved convention.** Typed retrieval omits and reports unresolved note identities instead of failing the whole index, stale projections fail loudly, managed template sources are excluded, and every advertised search operation remains byte-identical read-only.
- **Doctor and template mutation use exact public operations and durable recovery.** Doctor exposes `validate`, `regenerate-types`, and `backfill-defaults`; interrupted template transactions resume by persisted transaction ID and the original approved digest instead of reconstructing mutable caller state.

## [0.8.4] - 2026-08-30

## [0.8.3] - 2026-08-29

## [0.8.2] - 2026-08-29

## [0.8.1] - 2026-08-29

## [0.8.0] - 2026-08-29

## [0.7.0] - 2026-08-27

### Breaking

- An MCP host that launches `oms mcp` with no `--vault` argument and no `OMS_VAULT` in its env block no longer resolves a vault from the global registry. Such a server resolves to its launch directory and rejects writes with `target-unverified`; host configurations must pass the vault explicitly. The Claude installer now does this on your behalf (see the vendors changelog); other hosts need the configuration updated by hand.

## [0.6.2] - 2026-08-27

## [0.6.1] - 2026-08-27

## [0.6.0] - 2026-08-27

### Changed

- MCP semantic retrieval now forwards explicit rerank and candidate-limit requests through ephemeral lexical fallback paths without downloading models or silently dropping rerank behavior.
- **Breaking:** `oms_search` folds axis retrieval into the `query` operation. The retired `axis` and `semantic-query` operation names now fail loudly; collection, context, and status operations likewise drop their `semantic-` prefixes. Query responses expose `hits`, `totalCount`, `facets`, a cursor, and a deterministic receipt.
- **Breaking:** `oms_doctor` uses `op: "cleanup"` instead of the removed `semantic-cleanup` spelling. No compatibility aliases are retained.

## [0.3.0] - 2026-08-24

### Changed

- `oms_search` is genuinely read-only and is now annotated as such. It previously advertised `readOnlyHint: false`, and truthfully so: searching a vault with no index silently created `.oms/` and initialised an SQLite store, and the `embeddingSyncBeforeSearch` family of parameters let any caller turn a search into a write by passing a flag. Neither is possible now. This matters beyond tidiness, because MCP hosts may auto-approve tools that declare themselves read-only.

  Searching an unindexed vault still returns results. Rather than refusing until you run a command, the server builds the lexical index in memory for the life of the session and answers from that, so a first search on a fresh vault behaves as it always did while leaving the vault byte-identical. Once a persistent index exists it is used as-is and a search never rewrites it; refreshing it is `oms semantic sync`'s job.

  Preparing lexical or embedding data on disk is now exclusively `oms_doctor { op: "sync-embeddings" }`, which is annotated as writing and routes through the verified-target kernel. Asking for vector retrieval on a vault with no vectors still fails loudly rather than quietly degrading to lexical.
- `oms_search` advertises `limit` (default 10), `minScore` (default 0) and `rerank` (default false). The first two are applied at the normalizer, so an options-free query is bounded rather than unlimited. `rerank` is opt-in per ADR-011: `true` reranks only when startup was given a real reranker and otherwise fails loudly with configuration guidance, rather than silently returning unreranked results as if the request had been honoured.

- The public MCP surface is now five tools — `oms_write`, `oms_search`, `oms_link`, `oms_status`, `oms_doctor` — down from twenty-three. The eighteen detail tools are reachable through an `op` parameter on the tool that owns them; nothing was deleted, so no capability is lost, but any client calling a detail tool by its old name must switch to the owning tool plus `op`.
- `oms_search` routes through the `SearchBackend` seam. A plain `query` now expands to lexical retrieval and returns results on a vault with no embedding provider, where it previously failed. Asking explicitly for vector retrieval — through a typed `vec` or `hyde` sub-search, the `vec`/`hyde` shorthands, or `mode: "vsearch"` — still fails loudly naming `OMS_EMBEDDING_PROVIDER` and `OMS_EMBEDDING_MODEL`. Lexical is a default for callers who did not choose a strategy, never a substitute for one that was asked for.
- Supplying an explicit `mode` together with explicit `searches` is refused as contradictory rather than resolved by discarding one of them.
- `oms_write` refuses a request that addresses the note both ways at once. `notePath` and `folder`/`filename` are alternatives; supplying both used to write one form while reporting the other's implications.
- Every mutating `oms_doctor` repair returns a typed receipt whose postcondition the server verified by reading persisted state back. Repairs are admitted through the verified-target kernel before anything touches disk, so a `cwd`-inferred target is rejected while diagnosis still works.

### Removed

- The qmd-compatible aliases `query`, `get`, `multi_get` and `status`, and the `qmd://` resource, are gone. ADR-009's D2 is superseded by ADR-010; D1 remains in force.
