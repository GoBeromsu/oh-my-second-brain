# Verified target admission

Reading can use the current directory, but mutation cannot guess a vault. OMS therefore separates target resolution from verified-target admission. `status` is read-only; `doctor` diagnosis is read-only; note writes and doctor repairs require an admitted target.

## Resolution precedence

The runtime resolves the first available source in this order:

| Priority | Source | Result |
| ---: | --- | --- |
| 1 | Explicit `--vault <path>` | Verified target |
| 2 | Local `.oms` template controls | Verified target |
| 3 | Local bridge | Verified target |
| 4 | `OMS_VAULT` | Verified target |
| 5 | Current working directory | Read-only fallback; mutations rejected |

The precedence is the same for CLI and MCP runtime behavior. A host installation does not change it: installation only stamps `oms mcp --vault <path>` into that host's registration, making that invocation explicit.

## Admission boundary

Before a mutation, OMS resolves the target and verifies that the requested path is confined to it. It then resolves the managed template and validates the operation's mode preconditions. Admission happens before disk mutation, so a rejected request does not modify a note or managed template.

Note writes use a `ResolvedTemplate` and have three modes:

- `create` requires a new destination.
- `append` requires an existing destination.
- `update` requires an existing destination.

A successful note write returns a receipt containing the resolved vault, resolution source, operation, and note path. Dry runs return a proposed result rather than a write receipt.

## Template mutations

Managed-template mutations are also mutations of the verified target. They must first produce a dry run, then be applied with the exact `--approved-digest` from that review. The apply operation uses compare-and-swap and returns a transaction receipt. A stale approval cannot apply after the reviewed template state changes.

Setup follows this same approval model: it recursively discovers existing templates and proposes migration, but never modifies notes. It has no bundled default authority.

## Read-only and repair operations

`oms status` has no mutation path. `oms doctor` can diagnose from a read-only fallback, while regenerate and backfill operations require verified-target admission. Search remains lexical and projection-independent; it can be used without generated projection state.

For the vault data model and generated files, see [conventions](./conventions.md). For host registration, see [installation](./install.md).
