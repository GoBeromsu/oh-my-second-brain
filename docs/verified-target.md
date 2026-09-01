# Verified target admission

Reading can use the current directory, but mutation cannot guess a vault. OMS separates target resolution from verified-target admission. The status skill, `oms_status` MCP tool, and doctor diagnosis are read-only; note writes and doctor repairs require an admitted target.

## Resolution precedence

The runtime resolves the first available source in this order:

| Priority | Source | Result |
| ---: | --- | --- |
| 1 | Explicit `--vault <path>` | Verified target |
| 2 | Local `.oms` template controls | Verified target |
| 3 | Local bridge | Verified target |
| 4 | `OMS_VAULT` | Verified target |
| 5 | Current working directory | Read-only fallback; mutations rejected |

The precedence is the same for CLI and MCP runtime behavior. Host installation does not change it: host lifecycle commands keep a signed `${XDG_CONFIG_HOME:-~/.config}/oms/vault.json` maintenance pointer and stamp `oms mcp --vault <path>` into host registrations. Only the stamped argument participates in runtime resolution; `resolveEffectiveVault` never reads the pointer.

## Admission boundary

Before a mutation, OMS resolves the target and verifies the requested path is confined to it. It then resolves the managed template and validates the operation's mode preconditions. Admission happens before disk mutation, so rejection does not modify a note or managed template.

Note writes use a `ResolvedTemplate` and have three modes:

- `create` requires a new destination.
- `append` requires an existing destination.
- `update` requires an existing destination.

A successful note write returns a receipt containing the resolved vault, resolution source, operation, and note path. Dry runs return a proposed result rather than a write receipt.

## Template mutations

Managed-template mutations also require a verified target. They first produce a dry run, then apply with the exact `--approved-digest` from review. Apply uses compare-and-swap and returns a transaction receipt. A stale approval cannot apply after reviewed template state changes.

Setup follows this approval model: it recursively discovers existing templates and proposes migration, but never modifies notes. It has no bundled default authority.

## Read-only and repair operations

`oms index status` has no mutation path. `oms doctor` can diagnose from a
read-only fallback, while regenerate and backfill operations require
verified-target admission. `oms search <text>` remains lexical and
projection-independent; it can be used without generated projection state.
`--vec`, `--hyde`, G004 `--expand`, and `--rerank` are explicit channels, and
`--max-queries` accepts only integers from 1 through 32. Vector search requires
the `OMS_EMBEDDING_PROVIDER` and `OMS_EMBEDDING_MODEL` pair; HyDE additionally
requires `OMS_GENERATE_PROVIDER` and `OMS_GENERATE_MODEL`, and reranking
requires `OMS_RERANK_PROVIDER` and `OMS_RERANK_MODEL`. Missing or incomplete
pairs fail loudly. G004 expansion is available when explicitly selected and
makes no replacement, parity, or outperformance claim.

For vault data and generated files, see [conventions](./conventions.md). For host registration, see [installation](./install.md).
