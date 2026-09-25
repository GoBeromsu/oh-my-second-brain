# Vault conventions

The vault is the user's plain Markdown. Obsidian can open it with no OMS process. OMS does not own the notes, and it does not hardcode property names, folders, or personas. Ontology is the user's statement of what a folder, a property, or a template means; the user states it once by sealing the vault contract.

The vault contract is recorded in ADR-007 (`docs/decisions/` in the source repository), which replaces the former ADR-013 through ADR-016. [ACKNOWLEDGMENTS](../ACKNOWLEDGMENTS.md) credits Ouroboros and Gajae Code's deep-interview as acknowledged design ideas, not ported code and not a research result. This page is approved architecture. It is not a host-smoke result.

## Where meaning lives

| Path | Role |
| --- | --- |
| Vault Markdown notes | User-owned plain Markdown. The agent writes them through MCP `write` or, in Claude Code, through native tools that the guard hook judges. |
| Template files in `templateFolder` | The user's own Markdown. Sealing records what each one declares; OMS never rewrites, copies, or applies them. |
| `.oms/settings.json` | The only OMS file inside the vault. Holds `version`, `vaultId`, `templateFolder`, `embedding`, and `agentRepair`. It is not the contract. |
| `.obsidian/types.json` | Read-only Obsidian observation. OMS never writes it and it never overrides the seal. |
| `~/.oms/vaults/<vault-id>/` | The sealed contract, outside the vault. Agents never read or write it. |
| Engine store, graph cache, node index | Rebuildable caches outside the vault. Do not commit them. |

Any other entry under `.oms/` is ignored by OMS and reported by `oms contract doctor` as an unexpected control file. Files left there by an older OMS version, such as a published template policy, a taxonomy, or a type projection, are no longer read. A `templateRoots` key in `.oms/settings.json` is rejected; the setting is now `templateFolder`.

## What the seal holds

The contract has three axes, sealed together in one interview:

- **Folders.** Each registered folder carries a meaning and whether search should exclude it. When folders are sealed, a note written outside every registered folder is denied as `unregistered-folder`.
- **Property pool.** Each property carries a meaning, an Obsidian type, whether it is required, and optional rules: an allowed set, a fixed value, a pattern, or a range. When the pool is sealed, a frontmatter key outside it is denied as `unknown-property`.
- **Templates.** Each template records its source path and content hash, an optional apply folder, and the properties, narrowed rules, and headings it requires.

An axis the user did not seal stays open: nothing is judged for it. A vault with no seal on this machine is not judged at all. Extra body text and descendant headings stay free. OMS does not fill in required values, apply a template to a note, or expand a naming expression, and it does not parse or execute Templater, JavaScript, or a private token language. A value that still holds a template variable is denied as `unsubstituted-variable`.

When a write names a `template`, the note must satisfy it and sit inside its apply folder. When a write names none, an edit to a note that already satisfied a template must keep satisfying one of the templates it satisfied.

## Sealing and drift

`oms setup` (the same command as `oms contract setup`) interviews the whole vault at an interactive terminal and seals the contract. The interactive interview refuses to run without a TTY or under `OMS_NON_INTERACTIVE=1`. An agent seals only through the `setup` skill: `oms setup --questions` prints the questions as JSON, the agent asks the owner each one, and `oms setup --answers <file|->` seals a first contract or a reseal that only adds or tightens. A loosening reseal is refused there with `{field, kind}` only and is left to the owner's terminal. It writes only `.oms/settings.json` inside the vault and never modifies notes. Model install, selection, waiver, and status are separate `oms model` leaves.

A later edit to a sealed template file is drift. `oms contract status` reports each sealed template as `active`, `drift`, or `missing` against the live file. Drift is reported, never re-sealed silently; the user re-seals by running `oms setup` again. `oms contract extract --template <path>` shows what one template declares without printing values.

When this machine holds seal evidence that no longer matches the vault, every write is refused as `contract-unreadable` until the user runs `oms setup` again. OMS never substitutes an empty contract for an unreadable one. `oms contract doctor` diagnoses the seal, stale locks, orphaned generations, unexpected control files, and hook transport failures; `--fix` only re-indexes a moved or unindexed vault.

## Notes, search, and what may be committed

The agent writes the whole note. A denied write leaves the file unchanged and returns only `{field, kind}` violations and one guidance command, never a rule value, a store path, or the contract body. An allowed write means the note fits the sealed structure, not that it is worth keeping; that judgement stays with the user and the agent. OMS has no completion call and no reviewer conversation. Create, append, update, backfill, and complete are not note operations. Link leaves are suggest and check. Link apply is not an operation.

`oms note audit` judges existing notes against the seal and reports `{path, field, kind}` entries. It never rewrites a note.

`oms search query <text>` is plain lexical search and reads no contract. `--vec`, `--hyde`, G004 `--expand`, and `--rerank` are explicit channels. `--max-queries` accepts only integers from 1 through 32. Lexical, vector, HyDE, and typed-axis queries include notes that would fail the contract, and a missing or damaged contract does not stop search. Vector search requires `OMS_EMBEDDING_PROVIDER` and `OMS_EMBEDDING_MODEL`. HyDE also requires `OMS_GENERATE_PROVIDER` and `OMS_GENERATE_MODEL`. Reranking requires `OMS_RERANK_PROVIDER` and `OMS_RERANK_MODEL`. An incomplete pair fails loudly. G004 expansion makes no replacement, parity, or outperformance claim. Search does not write notes. This is the ADR-005 rule, not a new backend.

Index and graph maintenance are `oms index sync`, `oms index embed`, `oms index repair`, `oms index clean`, and `oms graph build`. `oms index status` is read-only. The `status` skill, `oms status`, and the `status` MCP tool are read-only. Note backfill is not a repair.

Every leaf and discriminator is in [the CLI map](./cli-map.md). Admission is in [verified targets](./verified-target.md). The authority rationale is in [architecture](./architecture.md).

`.oms/settings.json` may be committed with the notes it governs. The sealed contract lives outside the vault and is per machine. The engine store, the graph and node caches, and the external runtime journal are rebuildable and must not be committed.
