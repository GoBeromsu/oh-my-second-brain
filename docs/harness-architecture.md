# Harness Architecture

Oh My Second Brain is an Obsidian-first convention layer over plain Markdown. Obsidian remains the command center, and the vault remains readable without OMS. The user owns meaning and seals it once through an interactive interview. The agent writes notes. OMS judges each write against the sealed contract and keeps the contract itself out of the agent's reach.

The sequence in this page is a repository sketch. It is not a host-smoke result or a product-gate pass. The vault contract is recorded in [ADR-007](./decisions/ADR-007-vault-contract-ontology.md), which replaces the former ADR-013 through ADR-016 and supersedes [ADR-008](./decisions/ADR-008-taxonomy.md). [ACKNOWLEDGMENTS](../ACKNOWLEDGMENTS.md) credits Ouroboros and Gajae Code's deep-interview as ideas that were not ported and were not turned into a research claim.

## Authority the harness enforces

The harness does not invent a vault's fields, folders, or personas.

1. The sealed contract lives outside the vault, under `~/.oms/vaults/<vault-id>/` (`src/kernel/contract/store.ts:51-53`, `storeRoot`). It has three parts: `folders.json` (folder meaning and placement), `properties.json` (the property pool), and one `templates/<name>.json` per sealed template. `<vault-id>` is a symbolic link to a generation directory; a reseal builds a new generation and swaps the link in one rename, keeping the current and previous generations (`store.ts:524-595`, `sealContract`).
2. The only file OMS keeps inside the vault is `.oms/settings.json` (`version`, `vaultId`, `templateFolder`, `embedding`, `agentRepair`; `src/kernel/vault/settings.ts:28`, `KEYS`). Any other entry in `.oms/` is reported by `oms doctor contract` as an unexpected control file and is otherwise ignored (`src/kernel/contract/status.ts:93-104`, `unexpectedControlFiles`).
3. `.obsidian/types.json` is read-only observation. It never overrides the sealed contract.

A template stays the user's own Markdown file in `templateFolder`. Sealing records what it declares; OMS never rewrites or copies it, and it never applies a template to a note. `oms setup status` reports each sealed template as `active`, `drift`, or `missing` against the live file (`src/kernel/contract/drift.ts:8`, `templateDrift`). A drifted template is reported, never re-sealed silently.

## Seal, then judge

- **Seal.** `oms setup` interviews the person at a terminal and seals folders, properties, and templates together. It refuses to run without an interactive terminal or under `OMS_NON_INTERACTIVE=1`, so an agent never runs it (`src/cli/contract-command.ts:210-216`, `setup`).
- **Judge.** One judge decides every write (`src/kernel/contract/judge.ts:194-211`, `judge`). MCP `write {path, content, template?, ifMatch?, check?}` conforms, judges the whole note and saves it only when it is allowed (`src/mcp/tools/write.ts:20-40`, `writeNote`, over `src/kernel/write/pipeline.ts`, `runWritePipeline`). Claude's native Write, Edit, MultiEdit, and NotebookEdit reach the same judge through `oms hook pre`, which rebuilds the resulting note before judging (`src/vendors/claude/hook/pre-tool-use.ts:115-156`, `translatePreToolUse`).
- **Deny.** Only a safety refusal denies; other findings are warnings on the allowed write. A denied write leaves the file unchanged and returns only `{field, kind}` refusals and one guidance command. It never returns a rule value, a store path, or the contract body (`src/kernel/contract/types.ts:158-199`, `GUIDANCE` through `formatDenyReason`).

A vault with no seal on this machine is not judged; writes pass with a `contract-open` warning suggesting `oms interview`. When the `.oms/settings.json` vault id differs from this machine's index, writes are refused as `contract-tampered`. When the store is missing or its manifest or schema is broken, or `.oms/settings.json` is missing or invalid, writes pass with a `contract-unreadable` warning suggesting `oms interview`.

OMS has no completion call or reviewer protocol. An allowed write means the note matches the sealed structure, not that it is worth keeping; the agent and user decide that.

## Hook transport

Claude's `oms-guard.mjs` wrapper denies native reads and writes under `~/.oms/**` without spawning anything, and asks the judge only for writes inside `OMS_VAULT` or `OMS_AGENT_VAULT` (`assets/claude/hooks/oms-guard.mjs:321-394`, `main`). When the judge cannot be reached (spawn failure, timeout, non-zero exit, malformed output), the write is allowed with one stderr line and the failure kind is counted for `oms doctor contract` (`oms-guard.mjs:156-178`, `recordGuardEvent` and `transportFailure`). Codex and Hermes declare no write hook; their writes are judged only when they go through MCP `write`. Host mechanisms are in the [host asset contract](./adapters.md).

## Retrieval and maintenance

Lexical, vector, HyDE, and typed-axis retrieval include notes that would not pass the judge. Search does not write or repair. Folder intents for search come from the sealed folder contract as `folderIntents` (`src/kernel/engine/mcp/types.ts:166`, `McpSemanticReceipt`). Vector, HyDE, and rerank fail loudly when their capability pair is missing or unusable, per ADR-005, rather than returning a fake match.

`status` is read-only. `oms setup status` shows the seal posture and template drift without printing values. `oms doctor contract` diagnoses the seal, stale locks, orphaned generations, unexpected control files, and hook transport failures; `--fix` only re-indexes a moved or unindexed vault (`status.ts:133-140`, `doctorFix`). Any other broken seal is recovered by running `oms setup` again. The engine store, graph cache, and node index are outside the vault and rebuildable.

## Surfaces

The public sets are intentionally different:

- six skills: `distill`, `doctor`, `interview`, `search`, `setup`, `write`;
- four capability-only local MCP tools: `write`, `search`, `interview`, `doctor`;
- seven CLI families, listed only in [the CLI map](./cli-map.md).

Detail capabilities remain `op` values under the four tools. Annotations are per tool, so only `search` is annotated read-only; `write` saves notes, `interview` shares the setup posture while sealing nothing, and `doctor` carries repair ops. Link suggestion (`search` `op: link`) and link checking (`doctor` `op: link-check`) never apply edits. Sealing has no MCP operation.

Host adapters differ natively, but they register the same MCP runtime and stamp the selected vault into `oms serve mcp --vault`. That stamp does not change resolution precedence: explicit target, local `.oms/settings.json`, bridge, `OMS_VAULT`, then read-only current-directory fallback. A current-directory vault is refused for sealing and for `oms doctor contract --fix` (`contract-command.ts:295-298`, `runContractCommand`).

The runtime server id is `oms`. Qualifying hosts render the local names as `oms_write`, `oms_search`, `oms_interview`, and `oms_doctor`, never `oms_oms_*`. Raw MCP callers use the local names.

The five top-level source directories remain `src/assets`, `src/cli`, `src/kernel`, `src/mcp`, and `src/vendors`. No new top-level source directory and no new MCP tool are part of this harness.
