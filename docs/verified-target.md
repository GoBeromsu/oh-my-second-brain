# Verified target admission

Search and diagnosis can use the current directory, but a writing workflow cannot guess a vault. OMS separates target resolution from verified-target admission. Note `guide` selects a contract and `check` reads a saved note; neither writes ordinary notes, and both require a verified target. Contract publication and derived-state repair also require an admitted target.

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

OMS does not write ordinary notes. `guide` selects the contract for one explicit new or existing path and returns a session locator; an unset path is a question and does not issue a session. The agent writes and repairs the file. `check` reads the saved bytes through that locator, reports declared properties and headings, and returns `semantic: "not-evaluated"`. There is no `complete` operation or separate reviewer handshake.

The structural check is not a claim that a note is semantically complete, that the whole vault stayed unchanged, that a hook blocked a save, or that the host enforced a tool sandbox. Claude's write hook is fail-open. Codex and Hermes have no write hook.

## Contract publication

Publishing version-5 controls requires a verified target. The common contract is always on and has no Markdown file of its own. OMS declares no common field itself; it holds exactly what the published document says, and nothing until the user writes fields into it. Explicitly registered templates retain their user-owned Markdown sources by recorded path and hash; they may add to, tighten, or relax the common contract. A note with no registered template is valid under the common contract. A historical version-3 or version-4 policy is readable and migrates in place only on a mutating selection that preserves its recorded meaning; a held or unproved contract is `review-required`.

`oms template publish --policy <file.json> --transaction-id <uuid> [--yes]` previews without `--yes`, then compare-and-swaps the exact policy bytes on disk. A valid hand-edited policy remains revisable. Publication writes only the policy and one history record; ordinary notes and original template sources are not publication outputs.

Setup writes portable `.oms/settings.json` identity and the approved host connection after the user approves the digest from `--dry-run`; it can select a model in the same pass. It publishes no contract and never modifies ordinary notes.

An absent, unreadable, malformed, or historical policy, or a contract transaction still in progress, stops the affected selection or check. An unreadable control is reported as its own state, including `CONTRACT_POLICY_UNREADABLE`, `TEMPLATE_POLICY_UNREADABLE`, or `TEMPLATE_TAXONOMY_UNREADABLE`; it is never replaced with an empty contract.

## Read-only and repair operations

`oms index status` has no mutation path. `oms template check` and read-only search can use the current-directory fallback. Index repair, index clean, and graph build require verified-target admission. Note backfill is not a repair. Type regeneration is retired.

`oms search query <text>` remains lexical and projection-independent; it can be used without generated projection state. Read-only search does not depend on policy validity. Unbound, invalid, and incomplete notes stay in lexical, vector, HyDE, and typed-axis results. Search does not write notes and does not start a reviewer workflow.

`--vec`, `--hyde`, G004 `--expand`, and `--rerank` are explicit channels, and `--max-queries` accepts only integers from 1 through 32. Vector search requires the `OMS_EMBEDDING_PROVIDER` and `OMS_EMBEDDING_MODEL` pair; HyDE additionally requires `OMS_GENERATE_PROVIDER` and `OMS_GENERATE_MODEL`, and reranking requires `OMS_RERANK_PROVIDER` and `OMS_RERANK_MODEL`. Missing or incomplete pairs fail loudly. G004 expansion is available when explicitly selected and makes no replacement, parity, or outperformance claim.

For vault data and generated files, see [conventions](./conventions.md). For host registration, see [installation](./install.md).
