# CLI and MCP surface map

OMS exposes seven CLI command families and exactly four MCP tools. The families are `search`, `interview`, `write`, `setup`, `doctor`, `serve`, and the hidden `hook`. CLI commands that have no MCP equivalent remain first-class CLI capabilities; MCP detail operations are discriminated by `op` and never become extra tools.

The MCP server advertises exactly `write`, `search`, `interview`, and `doctor`. The server id is `oms`; the tables below use the host-qualified spellings `oms_write`, `oms_search`, `oms_interview`, and `oms_doctor`, not additional wire tools.

The six skills are `distill`, `doctor`, `interview`, `search`, `setup`, and `write`. `distill` and `setup` are tool-less. Skills are workflows. They are not the four tools.

The migration from the 0.18 spellings is [the 0.19 migration guide](./migration-0.19.md).

## Annotations are per tool

MCP annotations describe a whole tool, not one of its operations. A tool is annotated read-only only when every operation it accepts is read-only, so the read-only set is exactly `readTools == [search]`:

| Tool | `readOnlyHint` | Why |
|---|---|---|
| `oms_search` | `true` | Every search operation, including `path` reads and link suggestions, reads the vault and writes nothing. |
| `oms_write` | `false` | Saves a note after the judge allows it. |
| `oms_interview` | `false` | Reads the vault and returns interview questions. It seals nothing, but it shares the setup posture and is not advertised as read-only. |
| `oms_doctor` | `false` | Its repair operations (`sync-embeddings`, `cleanup`, `build-graph`) mutate managed state. Its diagnosis operations (`status`, `validate`, `audit`, `link-check`) write nothing, and a `cwd`-inferred target still allows them. |

## Write

| CLI | MCP tool | `op` | Meaning |
|---|---|---|---|
| `oms write <path>` (content on stdin) | `oms_write` | absent | Judge the whole note against the sealed contract and save it only when allowed. MCP takes `{path, content, template?}`. |

Both entrypoints call the same verified-target write kernel. Unknown or missing input keys are refused before any judgement. A denial leaves the file unchanged and returns only `{field, kind}` violations and one guidance command. A `cwd`-inferred target is refused.

## Search

| CLI | MCP tool | `op` | Required discriminator |
|---|---|---|---|
| `oms search <text>` | `oms_search` | `query` | Optional explicit `mode=query|search|vsearch`; typed `searches` and lexical/vector/HyDE shorthand omit `mode`. |
| `oms search --context` | `oms_search` | `context` | none |
| `oms search --path <rel>` | `oms_search` | absent | `path` alone; exclusive with `op` and every other argument. Engine-free, normalization-insensitive exact read of one note. |
| `oms search --link <note>` | `oms_search` | `link` | `notePath` required, `folder` optional. Suggests wikilinks without writing them. |
| none | `oms_search` | `templates` | List sealed template axes. Reports `unavailable` when no contract is sealed. |
| none | `oms_search` | `get-document` | `target` XOR `targets` XOR (`notePath` and window). |
| none | `oms_search` | `index-status` | `view=status|collections|contexts` |

A plain `oms search <text>` is lexical-only. Search is independent of the contract: lexical, vector, HyDE, and typed-axis queries still include notes that would fail it, and a missing or damaged contract does not stop search. Search does not write notes and does not create an engine store.

## Interview and setup

| CLI | MCP tool | `op` | Meaning |
|---|---|---|---|
| `oms interview` | `oms_interview` | absent | The CLI runs the interactive interview; it refuses without a TTY or under `OMS_NON_INTERACTIVE=1`. The MCP tool returns the interview questions and seals nothing. |
| `oms setup` | none | — | Interview the whole vault and seal its contract. Interactive terminal only. Writes only `.oms/settings.json` inside the vault. |
| `oms setup extract --template <path>` | none | — | Show one template source and the `sourceHash` OMS computed for it. OMS never parses template text. |
| `oms setup status` | none | — | Report the seal's posture and each sealed template as `active`, `drift`, or `missing` against the live file. |
| `oms setup host install|remove|sync|status` | none | — | Manage host-native assets and registrations. `remove` refuses to run without `--yes` or `--dry-run`, unless `OMS_NON_INTERACTIVE=1`. |
| `oms setup package check|update` | none | — | Check or update the npm package without implicitly syncing hosts. |
| `oms setup model install|select|waive|status` | none | — | Manage model acquisition, selection, waiver, and status. |
| `oms setup bridge add|remove|status` | none | — | Manage repository-to-vault bridge configuration. There is no bridge repair command. |

Sealing has no MCP operation. The sealed contract lives outside the vault under `~/.oms/vaults/<vault-id>/`. A drifted template is reported, never re-sealed silently; the user re-seals by running `oms setup` again.

## Doctor

| CLI | MCP tool | `op` | Meaning |
|---|---|---|---|
| `oms doctor status` | `oms_doctor` | `status` | Read-only health: contract posture, engine, and graph. Creates no store. |
| `oms doctor contract [--fix]` | `oms_doctor` | `validate` | Diagnose the seal, stale locks, orphaned generations, unexpected control files, and hook transport failures. `--fix` only re-indexes a moved or unindexed vault; the MCP op fixes nothing. |
| `oms doctor audit` | `oms_doctor` | `audit` | Report `{path, field, kind}` entries for existing notes. Never rewrites a note. |
| `oms doctor link-check [<note>]` | `oms_doctor` | `link-check` | Report broken wikilinks. |
| `oms doctor sync-embeddings --mode sync|embed|repair` | `oms_doctor` | `sync-embeddings` | `mode` is exclusive; repair takes `repairMode=rebuild|drop` and optional `dryRun`. |
| `oms doctor cleanup` | `oms_doctor` | `cleanup` | Remove derived index entries for notes that no longer exist. |
| `oms doctor build-graph` | `oms_doctor` | `build-graph` | Rebuild the vault graph. |

Every mutating doctor op requires verified-target admission and returns a receipt with a server-verified postcondition.

## Servers and hook

| CLI | Purpose |
|---|---|
| `oms serve mcp|http` | Start MCP or HTTP without creating a vault engine store at startup. |
| `oms hook pre` | Judge a Claude write against the vault contract before it is saved. The Claude guard denies on a contract violation and allows with a warning when the judge cannot run. Codex and Hermes have no write hook. |

OMS has no host launcher and no `--runtime gjc` command path.

## Removed commands and operations

The 0.18 families `contract`, `note`, `link`, `bridge`, `index`, `graph`, `host`, `package`, `model`, and `status` were removed in 0.19. Typing one exits 1 and prints its replacement; none is an alias. The older retired names `template`, `audit`, `reconcile`, `linkify`, `embed`, `doc`, `mcp`, `lint`, `install`, `uninstall`, and `update` behave the same way. The hook leaf `pre-tool-use` is retired in favour of `oms hook pre`.

The MCP `link` and `status` tools were removed in 0.19: link suggestion is `oms_search` with `op: "link"`, link checking is `oms_doctor` with `op: "link-check"`, and status is `oms_doctor` with `op: "status"`. Removed MCP operation aliases are `lazy-load`, `multi-get-documents`, and the standalone search operations `collections`, `contexts`, and `status`. The `write` tool accepts no `op`.
