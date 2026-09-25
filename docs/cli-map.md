# CLI and MCP surface map

OMS exposes fourteen CLI command families and exactly five MCP tools. The families are `setup`, `contract`, `note`, `link`, `bridge`, `search`, `index`, `graph`, `host`, `package`, `model`, `serve`, `hook`, and `status`. CLI commands that have no MCP equivalent remain first-class CLI capabilities; MCP detail operations are discriminated by `op` and never become extra tools.

The MCP server advertises exactly `write`, `search`, `link`, `status`, and `doctor`. The server id is `oms`; the tables below use the host-qualified spellings `oms_write`, `oms_search`, `oms_link`, `oms_status`, and `oms_doctor`, not additional wire tools.

The six skills are `distill`, `doctor`, `link`, `search`, `status`, and `write`. `distill` is tool-less. Skills are workflows. They are not the five tools.

The agent writes notes. `oms_write` takes `{path, content, template?}` with no `op`: the whole note is judged against the sealed contract and saved only when it is allowed. Unknown or missing input keys are refused before any judgement. A denial leaves the file unchanged and returns only `{field, kind}` violations and one guidance command. Sealing has no MCP operation and no skill.

## Contract

| CLI | MCP tool | `op` | Meaning |
|---|---|---|---|
| `oms setup` / `oms contract setup` | none | — | Interview the whole vault and seal its contract. Interactive terminal only; refused without a TTY or under `OMS_NON_INTERACTIVE=1`. Writes only `.oms/settings.json` inside the vault. |
| `oms contract extract --template <path>` | none | — | Show what one template declares, without printing values. |
| `oms contract status` | none | — | Report the seal's posture and each sealed template as `active`, `drift`, or `missing` against the live file. |
| `oms contract doctor [--fix]` | `oms_doctor` | `validate` | Diagnose the seal, stale locks, orphaned generations, unexpected control files, and hook transport failures. The CLI exits 1 when unhealthy. `--fix` only re-indexes a moved or unindexed vault; the MCP `validate` op returns the agent view and fixes nothing. |
| none | `oms_search` | `templates` | List sealed template axes. Reports `unavailable` when no contract is sealed. |

Every command above accepts `--vault <path>`. The sealed contract lives outside the vault under `~/.oms/vaults/<vault-id>/`. A drifted template is reported, never re-sealed silently; the user re-seals by running `oms setup` again. Any broken seal other than a moved or unindexed vault is recovered the same way.

## Note

| CLI | MCP tool | `op` | Required discriminator |
|---|---|---|---|
| none | `oms_write` | absent | `path` and `content`; optional `template` naming the sealed template the note follows. |
| `oms note audit` | `oms_doctor` | `audit` | optional `folder` |
| `oms note get` | `oms_search` | `get-document` | `target` XOR `targets` XOR (`notePath` and window) |

`note audit` judges existing notes against the seal and reports `{path, field, kind}` entries. It never rewrites a note. `note get` replaces the retired document aliases without changing single-target, multi-target, or windowed retrieval.

## Link and bridge

| CLI | MCP tool | `op` | Meaning |
|---|---|---|---|
| `oms link suggest` | `oms_link` | `suggest` | Suggest wikilink edits without writing them. `notePath` required, `folder` optional. |
| `oms link check` | `oms_link` | `check` | Check wikilinks. Replaces the retired lint command. |
| `oms bridge add` | none | — | Add repository-to-vault bridge configuration. |
| `oms bridge remove` | none | — | Remove bridge configuration. |
| `oms bridge status` | none | — | Read bridge configuration status. |

Link suggest and check do not edit notes. Bridge operations manage target resolution metadata. There is no bridge repair command.

## Search, index, graph, and status

| CLI | MCP tool | `op` | Required discriminator |
|---|---|---|---|
| `oms search query` | `oms_search` | `query` | Optional explicit `mode=query|search|vsearch` with `query`; typed `searches` and lexical/vector/HyDE shorthand omit `mode`. |
| `oms search context` | `oms_search` | `context` | none |
| `oms index sync` | `oms_doctor` | `sync-embeddings` | `mode=sync` |
| `oms index embed` | `oms_doctor` | `sync-embeddings` | `mode=embed` |
| `oms index repair --mode <mode>` | `oms_doctor` | `sync-embeddings` | `mode=repair`; `repairMode` is `rebuild` or `drop`; optional `dryRun` |
| `oms index status` | `oms_search` | `index-status` | `view=status|collections|contexts` |
| `oms index clean` | `oms_doctor` | `cleanup` | none |
| `oms graph build` | `oms_doctor` | `build-graph` | none |
| `oms graph status` | `oms_status` | `graph` | none |
| `oms status` | `oms_status` | absent | Read-only aggregate view. |

Index sync, embed, and repair are exclusive modes, not combinable `embed` or `force` booleans. Repair performs the same verified store backup and rebuild/drop through CLI and MCP; it is not forced embedding. The collections and contexts capabilities are views of `index-status`, not standalone search operations. Graph status returns graph-only health; the zero-argument status tool returns the aggregate view.

Search is independent of the contract. Lexical, vector, HyDE, and typed-axis queries still include notes that would fail it, and a missing or damaged contract does not stop search. Search does not write notes.

## CLI-only lifecycle and servers

| CLI | Purpose |
|---|---|
| `oms host install|remove|sync|status` | Manage host-native assets and registrations. Install is a user-run command. `remove` refuses to run without `--yes` or `--dry-run`, unless `OMS_NON_INTERACTIVE=1`. |
| `oms package check|update` | Check or update the npm package without implicitly syncing hosts. |
| `oms model install|select|waive|status` | Manage model acquisition, selection, waiver, and status. |
| `oms serve mcp|http` | Start MCP or HTTP without creating a vault engine store at startup. |
| `oms hook pre` | Judge a Claude write against the vault contract before it is saved. The Claude guard denies on a contract violation and allows with a warning when the judge cannot run. Codex and Hermes have no write hook. |

OMS has no host launcher and no `--runtime gjc` command path.

## Removed commands and operations

The former top-level `template`, `doctor`, `audit`, `reconcile`, `linkify`, `embed`, `doc`, `mcp`, `lint`, `install`, `uninstall`, and `update` commands have no compatibility aliases; each prints the command that replaces it. `oms template` is replaced by `oms contract setup|extract|status|doctor`. The hook leaf `pre-tool-use` is retired in favour of `oms hook pre`, and there is no post-tool-use hook. The old repository-bridge meaning of a standalone `link` command is now the `bridge` family. `oms note audit` is the note-family diagnosis; it is not the retired top-level `audit` command.

The public note leaves are `audit` and `get`. Create, append, update, backfill, guide, check, and complete are not note operations. Link leaves are `suggest` and `check`. Link apply is not an operation.

Removed MCP operation aliases are `lazy-load`, `multi-get-documents`, and the standalone search operations `collections`, `contexts`, and `status`; their capabilities remain reachable through `get-document` and `index-status` views as mapped above. The `write` tool no longer accepts `op`: the former guide, check, and template operations are gone. Note backfill and note completion are not MCP operations.
