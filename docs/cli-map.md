# CLI and MCP surface map

OMS exposes fourteen CLI command families and exactly five MCP tools. CLI commands that have no MCP equivalent remain first-class CLI capabilities; MCP detail operations are discriminated by `op` and never become extra tools.

The MCP server advertises exactly `write`, `search`, `link`, `status`, and `doctor`. The server id is `oms`; the tables below use the host-qualified spellings `oms_write`, `oms_search`, `oms_link`, `oms_status`, and `oms_doctor`, not additional wire tools.

## Template

| CLI | MCP tool | `op` | Required discriminator |
|---|---|---|---|
| `oms template scan` | `oms_search` | `template-scan` | none |
| `oms template list` | `oms_search` | `templates` | `templateId` absent |
| `oms template show <id>` | `oms_search` | `templates` | `templateId` required |
| `oms template add <folder>` | `oms_write` | `template` | `mode=register-folder` |
| `oms template add <file> --id <id>` | `oms_write` | `template` | `mode=register-existing` |
| `oms template add --id <id> --from <file>` | `oms_write` | `template` | `mode=create` |
| `oms template update <id>` | `oms_write` | `template` | `mode=update` |
| `oms template update <id> --class <class>` | `oms_write` | `template` | `mode=reclassify` |
| `oms template move --folder <folder>` | `oms_write` | `template` | `mode=relocate-folder` |
| `oms template remove <id>` | `oms_write` | `template` | `mode=remove`, explicit `deleteSource` boolean |
| `oms template default <id>` | `oms_write` | `template` | `mode=default` |
| `oms template check` | `oms_doctor` | `validate` | none |
| `oms template regenerate-types` | `oms_doctor` | `regenerate-types` | `dryRun` XOR `approvedDigest` |
| `oms template update --resume` | `oms_write` | `template` | `transactionId` and `approvedDigest` |

`template add` is one leaf with folder, existing-file, and `--from` forms. The `--from` form uses the registered `templateFolders[].default` creation destination. That folder is unrelated to note placement.

## Note

| CLI | MCP tool | `op` | Required discriminator |
|---|---|---|---|
| `oms note create` | `oms_write` | `note` | `mode=create`; explicit `templateId`, or declared `defaultTemplate` |
| `oms note append` | `oms_write` | `note` | `mode=append` |
| `oms note update` | `oms_write` | `note` | `mode=update` |
| `oms note audit` | `oms_doctor` | `audit` | optional `folder` |
| `oms note backfill` | `oms_doctor` | `backfill-defaults` | `notePath`, then `dryRun` XOR `approvedDigest` |
| `oms note get` | `oms_search` | `get-document` | `target` XOR `targets` XOR (`notePath` and window) |

Omitting `templateId` during create never selects the first template; it uses only `defaultTemplate` or returns `TEMPLATE_DEFAULT_UNDECLARED`. Append and update use the persisted note identity. `note get` replaces the retired document aliases without changing single-target, multi-target, or windowed retrieval capability.

## Link and bridge

| CLI | MCP tool | `op` | Meaning |
|---|---|---|---|
| `oms link check` | none | — | Check wikilinks; replaces the retired lint command. |
| `oms link suggest` | `oms_link` | `suggest` | Suggest wikilink edits. |
| `oms link apply` | `oms_link` | `apply` | Apply reviewed wikilink edits; optional `folder` scopes the operation. |
| `oms bridge add` | none | — | Add repository-to-vault bridge configuration. |
| `oms bridge remove` | none | — | Remove bridge configuration. |
| `oms bridge status` | none | — | Read bridge configuration status. |

Link operations edit wikilinks. Bridge operations manage target resolution metadata. There is no bridge repair command.

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

## CLI-only lifecycle and servers

| CLI | Purpose |
|---|---|
| `oms setup` | Inspect and publish the guarded vault setup proposal. |
| `oms host install|remove|sync|status` | Manage host-native assets and registrations. |
| `oms package check|update` | Check or update the npm package without implicitly syncing hosts. |
| `oms model install|select|waive|status` | Manage model acquisition, selection, waiver, and status. |
| `oms serve mcp|http` | Start MCP or HTTP without creating a vault engine store at startup. |
| `oms hook pre|post` | Run pre-tool-use or post-tool-use hooks; post records the tool result and does not build the graph. |

OMS has no host launcher and no `--runtime gjc` command path.

## Removed aliases

The former top-level `doctor`, `audit`, `reconcile`, `linkify`, `embed`, `doc`, `mcp`, `lint`, `install`, `uninstall`, and `update` commands have no compatibility aliases. The old repository-bridge meaning of a standalone `link` command is now the `bridge` family. `oms status` and `oms index embed` are retained names.

Removed MCP operation aliases are `lazy-load`, `multi-get-documents`, and the standalone search operations `collections`, `contexts`, and `status`; their capabilities remain reachable through `get-document` and `index-status` views as mapped above.
