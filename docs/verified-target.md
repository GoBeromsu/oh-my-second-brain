# Verified target admission

Search and diagnosis can use the current directory, but a writing workflow cannot guess a vault. OMS separates target resolution from verified-target admission. MCP `write`, sealing with `oms setup`, and derived-state repair require a verified target.

## Resolution precedence

The runtime resolves the first available source in this order:

| Priority | Source | Result |
| ---: | --- | --- |
| 1 | Explicit `--vault <path>` | Verified target |
| 2 | Local `.oms/settings.json` | Verified target |
| 3 | Local bridge | Verified target |
| 4 | `OMS_VAULT` | Verified target |
| 5 | Current working directory | Read-only fallback; mutations rejected |

The precedence is the same for CLI and MCP runtime behavior. Host installation does not change it: host lifecycle commands keep a signed `${XDG_CONFIG_HOME:-~/.config}/oms/vault.json` maintenance pointer and stamp `oms serve mcp --vault <path>` into host registrations. Only the stamped argument participates in runtime resolution; `resolveEffectiveVault` never reads the pointer.

## Admission boundary

Before a note, settings, or derived-state mutation, OMS resolves the target and verifies the requested path is confined to it. Admission happens before that write, so rejection modifies nothing.

MCP `write {path, content, template?, ifMatch?, check?}` resolves and admits the target, judges the whole note against the sealed contract, and saves it atomically, with `{field, kind}` warnings for contract findings. A safety refusal leaves the file unchanged and returns `{field, kind}` refusals and a `reason` ending in one guidance command. There is no `complete` operation or separate reviewer handshake.

An allowed write is a structural result, not a claim that a note is semantically complete. In Claude Code, native writes inside the configured vault are judged by the guard hook; when the judge cannot run, the hook allows the call with a warning and records the transport failure for `oms doctor contract`. Codex and Hermes have no write hook.

## Sealing

`oms setup` requires a verified target and an interactive terminal. It seals the contract under `~/.oms/vaults/<vault-id>/` and writes only `.oms/settings.json` inside the vault; it never modifies notes. A vault with no seal on this machine is not judged. A tampered vault id (a `.oms/settings.json` id that differs from this machine's index) refuses writes as `contract-tampered`. A missing or broken store, or a missing or invalid `.oms/settings.json`, lets writes through with a `contract-unreadable` warning suggesting `oms interview`. An unreadable seal is never replaced with an empty contract. `oms doctor contract` diagnoses the seal, and its `--fix` only re-indexes a moved or unindexed vault, or rebuilds an unreadable index.

## Read-only and repair operations

`oms doctor status` has no mutation path. Read-only search and status can use the current-directory fallback. Index repair, index clean, and graph build require verified-target admission. Note backfill is not a repair.

`oms search <text>` remains lexical. Read-only search does not depend on the contract: notes that would fail it stay in lexical, vector, HyDE, and typed-axis results. Search does not write notes and does not start a reviewer workflow.

`--vec`, `--hyde`, G004 `--expand`, and `--rerank` are explicit channels, and `--max-queries` accepts only integers from 1 through 32. Vector search requires the `OMS_EMBEDDING_PROVIDER` and `OMS_EMBEDDING_MODEL` pair; HyDE additionally requires `OMS_GENERATE_PROVIDER` and `OMS_GENERATE_MODEL`, and reranking requires `OMS_RERANK_PROVIDER` and `OMS_RERANK_MODEL`. Missing or incomplete pairs fail loudly. G004 expansion is available when explicitly selected and makes no replacement, parity, or outperformance claim.

For vault data and generated files, see [conventions](./conventions.md). For host registration, see [installation](./install.md).
