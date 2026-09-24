# CLI and MCP surface map

OMS exposes fourteen CLI command families and exactly five MCP tools. The families are `setup`, `template`, `note`, `link`, `bridge`, `search`, `index`, `graph`, `host`, `package`, `model`, `serve`, `hook`, and `status`. CLI commands that have no MCP equivalent remain first-class CLI capabilities; MCP detail operations are discriminated by `op` and never become extra tools.

The MCP server advertises exactly `write`, `search`, `link`, `status`, and `doctor`. The server id is `oms`; the tables below use the host-qualified spellings `oms_write`, `oms_search`, `oms_link`, `oms_status`, and `oms_doctor`, not additional wire tools.

The eight skills are `distill`, `doctor`, `interview`, `link`, `search`, `status`, `template`, and `write`. `interview` and `template` are tool-less. Skills are workflows. They are not the five tools.

Agents write and repair notes. OMS `guide` selects the contract before writing; `check` inspects the saved note. The `write` tool keeps a write posture because explicit contract publication and confirmed source changes mutate managed state. `guide` and `check` themselves write no vault bytes. Link's posture is read-only.

## Template

| CLI | MCP tool | `op` | Required discriminator |
|---|---|---|---|
| `oms template scan` | `oms_search` | `template-scan` | none |
| `oms template list` | `oms_search` | `templates` | `templateId` absent |
| `oms template show <id>` | `oms_search` | `templates` | `templateId` required |
| `oms template publish` | `oms_write` | `template` + `mode: "publish-contract"` | Publishes one explicit V5 contract revision. The document is the caller's own contract meaning. |
| `oms template review-sources` | `oms_write` | `template` + `mode: "review-sources"` | Read-only source review: drift, missing, unreadable, and held registrations. |
| `oms template acknowledge-source` | `oms_write` | `template` + `mode: "acknowledge-source"` | Confirms reviewed source bytes. The SHA advances by one revision; the contract rules do not change. |
| `oms template relink-source` | `oms_write` | `template` + `mode: "relink-source"` | Confirms a relocation to an explicitly named candidate. The original must be genuinely missing. |
| `oms template check` | `oms_doctor` | `validate` | Read-only contract diagnosis: policy, portable settings, held registrations, and source state. |
Policy version 5 is the authority. The common contract is always on, starts empty, and has no Markdown file of its own. A registration inherits it and may add, tighten, or — where the user approved it for that template — relax what the common contract says; a note with no registration is valid. A closed value set exists only where the document declares `valuePolicy: "closed"`. Publication writes the policy and one history record, compare-and-swapped against the exact bytes now on disk. It does not publish ordinary notes or the user's own template sources. The retired leaves `review`, `answer`, `commit`, and `regenerate-types` have no aliases.

Every mutating template mode requires an explicit `transactionId`, and publication previews without `--yes`. Source drift is reported for that registration only and leaves the published contract in place. A policy that is missing, damaged, or unreadable stops the affected evaluation and names which; it does not become an empty contract, and it does not stop search.

The host notice text and its two buttons are fixed in the [host asset contract](./adapters.md). Confirming starts the `interview` skill, which reviews the changed source before anything is published. Deferring makes no server call. Search, a general question, or a note error does not start it.

## Note

| CLI | MCP tool | `op` | Required discriminator |
|---|---|---|---|
| `oms note guide` | `oms_write` | `guide` | Selects the contract for one explicit saved path. Returns a session locator, the effective contract, and the registered source text. |
| `oms note check` | `oms_write` | `check` | Reads the saved note through the selection locator and reports declared fields and headings. No unsaved body and no caller PASS. |
| `oms note audit` | `oms_doctor` | `audit` | optional `folder` |
| `oms note get` | `oms_search` | `get-document` | `target` XOR `targets` XOR (`notePath` and window) |

`publish` compare-and-swaps the exact policy bytes on disk, requires the next revision number, verifies every declared source against its live bytes, and records one history revision. Without `--yes` it prints the revision, added, removed, and changed registrations and writes nothing. OMS never derives a rule from a file name or from template syntax.

Source review is its own lane: `review-sources` reads, and both mutating leaves publish one policy revision plus one history record through the verified-target write kernel. Without confirmation they return the review that would be confirmed and change nothing. SHA equality is candidate evidence, never permission to relink.

`check` is structural and locator-bound: the session holds the note path and the selected contract, so no caller-supplied rules reach it. It reports the declared frontmatter fields and headings the saved bytes do and do not satisfy; it issues no completion verdict and consumes no reviewer result. Whether a note is finished stays with the user and the agent. Host asset details remain in the [host asset contract](./adapters.md).

`note get` replaces the retired document aliases without changing single-target, multi-target, or windowed retrieval.

## Link and bridge

| CLI | MCP tool | `op` | Meaning |
|---|---|---|---|
| `oms link suggest` | `oms_link` | `suggest` | Suggest wikilink edits without writing them. |
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

Read-only search is independent of policy validity. Lexical, vector, HyDE, and typed-axis queries still include unbound, invalid, and incomplete notes. Search does not write notes. `oms status` reports observation, including separate source and contract state. It does not decide whether a note is finished.

## CLI-only lifecycle and servers

| CLI | Purpose |
|---|---|
| `oms setup` | Connect the vault: write its portable `.oms/settings.json` identity and the host connection after a dry-run approval digest, optionally selecting a model. It publishes no contract; that is `oms template publish`. |
| `oms host install|remove|sync|status` | Manage host-native assets and registrations. Install is a user-run command. `remove` refuses to run without `--yes` or `--dry-run`, unless `OMS_NON_INTERACTIVE=1`. |
| `oms package check|update` | Check or update the npm package without implicitly syncing hosts. |
| `oms model install|select|waive|status` | Manage model acquisition, selection, waiver, and status. |
| `oms serve mcp|http` | Start MCP or HTTP without creating a vault engine store at startup. |
| `oms hook pre|post` | Run pre-tool-use or post-tool-use hooks. Post records the tool result and does not build the graph. Claude's write hook is fail-open; Codex and Hermes have none. |

OMS has no host launcher and no `--runtime gjc` command path.

## Removed leaves

The public note leaves are `guide`, `check`, `audit`, and `get`. Create, append, update, backfill, and complete are not note operations. The public template leaves are `list`, `show`, `scan`, `check`, `publish`, `review-sources`, `acknowledge-source`, and `relink-source`. The derived-projection repair, the interview ledger leaves, and reclassification are not operations. Template add, update, move, remove, and default are not operations. Link leaves are `suggest` and `check`. Link apply is not an operation.

The former top-level `doctor`, `audit`, `reconcile`, `linkify`, `embed`, `doc`, `mcp`, `lint`, `install`, `uninstall`, and `update` commands have no compatibility aliases. The old repository-bridge meaning of a standalone `link` command is now the `bridge` family. `oms status` and `oms index embed` are retained names. `oms note audit` remains the note-family diagnosis; it is not the retired top-level `audit` command.

Removed MCP operation aliases are `lazy-load`, `multi-get-documents`, and the standalone search operations `collections`, `contexts`, and `status`; their capabilities remain reachable through `get-document` and `index-status` views as mapped above. Note-write modes, link apply, note backfill, and note completion are not MCP operations.
