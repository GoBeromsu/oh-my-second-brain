# Verified target admission

Search and diagnosis can use the current directory, but a writing workflow cannot guess a vault. OMS separates target resolution from verified-target admission. Note `guide` / `check` / `complete` read rather than write ordinary notes, but their task binding still requires a verified target. Contract publication and derived-state repair also require an admitted target.

## Resolution precedence

The runtime resolves the first available source in this order:

| Priority | Source | Result |
| ---: | --- | --- |
| 1 | Explicit `--vault <path>` | Verified target |
| 2 | Local `.oms` template controls | Verified target |
| 3 | Local bridge | Verified target |
| 4 | `OMS_VAULT` | Verified target |
| 5 | Current working directory | Read-only fallback; mutations rejected |

The precedence is the same for CLI and MCP runtime behavior. Host installation does not change it: host lifecycle commands keep a signed `${XDG_CONFIG_HOME:-~/.config}/oms/vault.json` maintenance pointer and stamp `oms serve mcp --vault <path>` into host registrations. Only the stamped argument participates in runtime resolution; `resolveEffectiveVault` never reads the pointer.

## Admission boundary

Before a control or derived-state mutation, OMS resolves the target and verifies the requested path is confined to it. Admission happens before that write, so rejection does not modify controls or derived state.

OMS does not write ordinary notes. `guide` returns approved contract material for a chosen new or existing path; an unset path is a question and does not issue a check. The agent writes and repairs the file. `check` reads the saved note, controls, and declared evidence. `complete` re-reads those inputs after a separate review.

Agreement of the evaluation inputs before and after review is the scope of that observation. It is not a claim that the whole vault stayed unchanged, that a hook blocked a save, or that the host enforced a tool sandbox. A definition byte match is a file comparison, not a launch or enforcement proof. Claude's write hook is fail-open. Codex and Hermes have no write hook.

## Contract publication

Publishing v4 controls requires a verified target. The default layer is always on and starts empty. An individual template only adds constraints. A note with no individual template is valid under the default. Version 3 is not converted automatically.

The publication path is a dry run, then apply with the exact approved digest from that review. Apply is compare-and-swap of the approved diff and returns a transaction receipt. A stale approval cannot apply after the reviewed control state changes. Ordinary notes and original template sources are not publication outputs.

Setup follows this approval model: it proposes an empty v4 policy and never modifies notes. It has no bundled note-type defaults.

An unverifiable policy or a contract transaction still in progress stops the affected `guide`, `check`, or `complete` evaluation. It does not replace the contract with an empty one.

## Read-only and repair operations

`oms index status` has no mutation path. `oms template check` and read-only search can use the current-directory fallback. Type regeneration, index repair, index clean, and graph build require verified-target admission. Note backfill is not a repair.

`oms search query <text>` remains lexical and projection-independent; it can be used without generated projection state. Read-only search does not depend on policy validity. Unbound, invalid, and incomplete notes stay in lexical, vector, HyDE, and typed-axis results. Search does not write notes and does not start a review.

`--vec`, `--hyde`, G004 `--expand`, and `--rerank` are explicit channels, and `--max-queries` accepts only integers from 1 through 32. Vector search requires the `OMS_EMBEDDING_PROVIDER` and `OMS_EMBEDDING_MODEL` pair; HyDE additionally requires `OMS_GENERATE_PROVIDER` and `OMS_GENERATE_MODEL`, and reranking requires `OMS_RERANK_PROVIDER` and `OMS_RERANK_MODEL`. Missing or incomplete pairs fail loudly. G004 expansion is available when explicitly selected and makes no replacement, parity, or outperformance claim.

For vault data and generated files, see [conventions](./conventions.md). For host registration, see [installation](./install.md).
