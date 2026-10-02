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
| `oms_interview` | `false` | `op: questions` reads the vault and returns the open interview questions. `op: answer`, `op: confirm`, and `op: seal` append to the interview log and seal a confirmed proposal on a verified target, so the tool is not advertised as read-only. |
| `oms_doctor` | `false` | Its repair operations (`sync-embeddings`, `cleanup`, `build-graph`, `lineage-recover`, `lineage-reanchor`, `evolve`, `evolve-verdict`, `revert-propose`, `reclaim-evolution-lock`) mutate managed state. Its diagnosis operations (`status`, `validate`, `gaps`, `audit`, `link-check`) write nothing, and a `cwd`-inferred target still allows them. |

## Write

| CLI | MCP tool | `op` | Meaning |
|---|---|---|---|
| `oms write <path> [--template <t>] [--if-match sha256:<rev>] [--check]` (content on stdin) | `oms_write` | absent | Judge the whole note against the sealed contract and save it only when allowed. MCP takes `{path, content, template?, ifMatch?, check?}`. |

Both entrypoints call the same verified-target write kernel. Unknown or missing input keys are refused before any judgement. Only a safety refusal denies: the payload is `{ok: false, status: "denied", refusals, violations, reason}`, the file is unchanged, and `violations` repeats `refusals` for older clients. Other findings are warnings. In a sealed vault, a note whose frontmatter does not parse is kept as a draft and returns `{ok: false, status: "drafted", draftRef, warnings}`; MCP does not mark it an error, and `oms write` exits 1. A new warning the contract reads the same way in another spelling (a number written as `"12"`, a scalar for a list, an allowed value that differs only in case, spacing or Unicode form, a missing value the contract fixes) is fixed losslessly; the original stays in the gap ledger. Every other warning, such as an unknown key or a value outside its rule, is saved as written and recorded as `kept`. A contradiction in the contract and a draft that cannot be kept are also saved. The receipt carries the saved note's `warnings` and the applied `fixes`; `oms write` also prints both to stderr. A `cwd`-inferred target is refused.

Both run one pipeline: frame the target, conform mechanically (template variables, date and datetime defaults on a new note, the chosen template's missing headings), judge, write, then update the keyword index of an existing engine store. Conform never supplies a required value, and apart from the variables it fills in the written text (`{{date}}` becomes today's date) it never changes an existing value. After the judge, coerce may fill a missing required value whose rule fixes it and apply the other lossless fixes; a fix changes only the bytes of that value, and a tagged or anchored value is kept as written.

- Overwriting an existing note needs `ifMatch` (`--if-match`) set to its current `sha256:` revision; without it nothing is written and the result is `WRITE_IF_MATCH_REQUIRED`. A stale revision returns the retryable `WRITE_TARGET_CHANGED`; `ifMatch` for a note that does not exist returns the retryable `WRITE_TARGET_ABSENT` (retry without it to create the note). A note removed after it was judged returns the retryable `WRITE_TARGET_VANISHED`; nothing is written.
- `check` (`--check`) judges and returns the frame, the current revision, and the `refusals`, `warnings`, and `fixes` without touching disk, the engine store or the contract store.
- A written note returns the receipt `{ok, path, revision, contractRevision, index: {keyword, vector}, conformed, missingDefaults, warnings, fixes, next?}`. `next` is the one command to run next for the first warning (`oms interview` for a `contract-open` vault, `oms doctor status` for a note's rule warnings) and is absent when there are no warnings. `warnings` is the note's full `{field, kind}` warning set, not only the new ones, left after the fixes; `fixes` lists the `{field, kind}` of each warning a lossless fix cleared. `index.keyword` is `updated` when an engine store exists, `skipped` when none does (the write never creates one), and `failed` when the store could not be updated; the note is written in every case. `index.vector` is `pending` after a keyword update, until `oms doctor sync-embeddings --mode embed` or an explicitly enabled full-maintenance server drains the queue, and `disabled` otherwise.

## Search

| CLI | MCP tool | `op` | Required discriminator |
|---|---|---|---|
| `oms search <text>` | `oms_search` | `query` | Optional explicit `mode=query|search|vsearch`; typed `searches` and lexical/vector/HyDE shorthand omit `mode`. After a `--` terminator the CLI reads every token, including `--vault`, as query text. |
| `oms search [<text>] --observed '<JSON field/discover object>' [-n 0]` | `oms_search` | `query` | Explicit `observed: {field?, discover?}`; text is optional, and `limit: 0` returns bounded discovery without hits. |
| `oms search --context` | `oms_search` | `context` | none |
| `oms search --path <rel>` | `oms_search` | absent | `path` alone; exclusive with `op` and every other argument, except `limit: 10`, `rerank: false` and `minScore: 0`, the schema defaults some clients echo on every call. Engine-free, normalization-insensitive exact read of one note, refused with `READ_EXACT_TOO_LARGE` above 16 MiB. A `--path` after a `--` terminator is query text, not the flag. |
| `oms search --link <note>` | `oms_search` | `link` | `notePath` required, `folder` optional. Suggests wikilinks without writing them. Refused when combined with a `--` terminator. |
| none | `oms_search` | `templates` | List the live templates in `templateFolder` as template axes. Reports `unavailable` when no contract is sealed. |
| none | `oms_search` | `get-document` | `target` XOR `targets` XOR (`notePath` and window). |
| `oms doctor status --view status|collections|contexts` | `oms_search` | `index-status` | `view=status|collections|contexts`; the CLI also takes `--index <path>` and `--collection <name>`. Read-only; never creates a store. |

For read-before-edit, use MCP `search {path: "note.md"}` without `op`, or CLI `oms search --path note.md`. Both return the complete source in `documents[0].content` and its current `sha256:` byte revision in `documents[0].revision`. Supply that revision as `write.ifMatch` (CLI `--if-match`). The separate MCP `get-document` operation is for document retrieval, including slices and batches, and does not return an overwrite revision. On `WRITE_TARGET_CHANGED`, reread the complete note and reconcile the requested edit before retrying.

A plain `oms search <text>` is lexical-only. Search is independent of the contract: lexical, vector, HyDE, and typed-axis queries still include notes that would fail it, and a missing or damaged contract does not stop search. Search does not write notes and does not create an engine store.

## Interview and setup

| CLI | MCP tool | `op` | Meaning |
|---|---|---|---|
| `oms interview` | `oms_interview` | absent | The CLI runs the interactive interview, continuing from the interview log (`--restart` starts over); it refuses without a TTY or under `OMS_NON_INTERACTIVE=1`. The MCP tool continues the same log over `op: questions`, `answer`, `confirm`, and `seal`; it seals only the proposal the owner confirmed and never reclaims a stale seal lock. |
| `oms setup` | none | — | Interview the whole vault and seal its contract. Interactive terminal only. Writes only `.oms/settings.json` inside the vault. First, each contract evolution awaiting the owner is shown with its loosening changes marked, and sealed only on an explicit approve (a reject closes it). |
| `oms setup --autonomy on|off` | none | — | Turn autonomous contract evolution on or off. Off by default; turning it on needs the owner in an interactive terminal, and its limits (1 a day, 3 a week) can only be lowered. |
| `oms setup extract --template <name>` | none | — | Preview what one live template in `templateFolder` would scaffold: its source, `folder:` selector, property names, and headings. An unknown name returns `status: "missing"` and exits 1. Templates are never sealed or judged. |
| `oms setup status` | none | — | Report the seal's posture and `legacyTemplates`, the number of templates an older (version 1 or 2) generation sealed, which are reported and never enforced. |
| `oms setup host install|remove|sync|status` | none | — | Manage host-native assets and registrations. `remove` refuses to run without `--yes` or `--dry-run`, unless `OMS_NON_INTERACTIVE=1`. |
| `oms setup package check|update` | none | — | Check or update the npm package without implicitly syncing hosts. |
| `oms setup model install|select|waive|status` | none | — | Manage model acquisition, selection, waiver, and status. |
| `oms setup bridge add|remove|status` | none | — | Manage repository-to-vault bridge configuration. There is no bridge repair command. |

Sealing has no MCP operation. The sealed contract lives outside the vault under `~/.oms/vaults/<vault-id>/`. A new generation stores folders and properties only; the user re-seals by running `oms setup` again.

## Doctor

| CLI | MCP tool | `op` | Meaning |
|---|---|---|---|
| `oms doctor status` | `oms_doctor` | `status` | Read-only health: contract posture, engine, graph, and `evolution` (journal counters including gap-refused, re-anchored and seq-restart, the requests awaiting the owner, the autonomous budget left today and this week, and whether the lineage has a gap now; `null` for an unsealed vault). Creates no store. With `--view`, `--index`, or `--collection` it prints the search-index view instead (see `index-status` under Search). |
| `oms doctor contract [--fix]` | `oms_doctor` | `validate` | Diagnose the seal, stale locks, orphaned generations, unexpected control files, and hook transport failures. `--fix` only re-indexes a moved or unindexed vault, or rebuilds an unreadable index; the MCP op fixes nothing. |
| `oms doctor gaps` | `oms_doctor` | `gaps` | Report the open gaps a write recorded against the sealed contract (`{id, notePath, axis, kind, field, drafted, stale}`, counted by axis and kind) and the contradictions inside the contract. Never prints a wanted value and creates no store, state directory, or ledger. The CLI exits 1 on a contradiction or an unreadable ledger. |
| `oms doctor audit` | `oms_doctor` | `audit` | Report `{path, field, kind}` entries for existing notes. Never rewrites a note. |
| `oms doctor link-check [<note>]` | `oms_doctor` | `link-check` | Report broken wikilinks. |
| `oms doctor sync-embeddings --mode sync|embed|repair` | `oms_doctor` | `sync-embeddings` | `mode` is exclusive; repair takes `repairMode=rebuild|drop` and optional `dryRun`. |
| `oms doctor cleanup` | `oms_doctor` | `cleanup` | Remove derived index entries for notes that no longer exist. |
| `oms doctor build-graph` | `oms_doctor` | `build-graph` | Rebuild the vault graph. |
| `oms doctor lineage-recover` | `oms_doctor` | `lineage-recover` | Under the seal lock, snapshot kept generations the lineage has not recorded and append the events the chain can account for (a missed seal, a seq restart, a pre-lineage store). A gap the chain cannot explain is refused with `CONTRACT_LINEAGE_GAP` and nothing is written. Rerunning is a no-op. |
| `oms doctor lineage-reanchor` | `oms_doctor` | `lineage-reanchor` | As `lineage-recover`, but a gap is recorded as a gap-anchor event so the lineage continues from the linked generation. Owner only: the CLI asks for confirmation in a terminal; without one, and always over MCP, it is refused with `LINEAGE_REANCHOR_REQUIRES_TTY`. |
| `oms doctor evolve --maker-session <id>` | `oms_doctor` | `evolve` | Turn the open write gaps into one contract evolution request and return its evaluator slots. Nothing is sealed. The maker session is required (`makerSessionId` over MCP); without it the op is refused with `EVOLUTION_MAKER_SESSION_REQUIRED`. A candidate that overlaps an existing meaning or drifts more than 0.3 from the first sealed generation is refused with `EVOLUTION_STAGE2_REFUSED`. |
| `oms doctor evolve-verdict --verdict <file\|->` | `oms_doctor` | `evolve-verdict` | Submit one evaluator verdict (`approve` or `reject`) bound to a request slot, then run the seal gate: no new refusal, the warning delta reported, a loosening or warning-raising candidate waits for the owner, and a MECE overlap or drift past 0.3 is rejected, and an autonomous seal needs the policy on, a 2-of-3 quorum, a warning delta of 0 or less and the rate limit. Each verdict must come from a separate evaluator, never the maker, with distinct session ids. The quorum is host-attested and recorded as `quorum: "host-attested"` on an autonomous seal. A postcondition that does not hold is `EVOLUTION_POSTCONDITION_FAILED`, or `EVOLUTION_POSTCONDITION_FAILED_AFTER_SEAL` with the sealed digest. |
| `oms doctor revert-propose --target <digest>` | `oms_doctor` | `revert-propose` | Propose a kept generation's contract, read from its snapshot, as a new forward candidate. A revert always requires owner approval: every revert waits for the owner at `oms setup`, whatever its direction or the autonomy policy, and stage 1 and stage 2 run when it is proposed. |
| `oms doctor reclaim-evolution-lock` | `oms_doctor` | `reclaim-evolution-lock` | Release a stale evolution lock. Owner only: the CLI asks in a terminal; otherwise, and always over MCP, it is refused with `EVOLUTION_RECLAIM_REQUIRES_TTY`. |

Every mutating doctor op requires verified-target admission and returns a receipt with a server-verified postcondition.

## Servers and hook

| CLI | Purpose |
|---|---|
| `oms serve mcp|http` | Start MCP or HTTP without creating a vault engine store at startup. Optional `--maintenance lexical|full` starts an explicit owner for an existing canonical store; otherwise no maintenance writer starts. |
| `oms hook pre` | Judge a Claude write against the vault contract before it is saved. The Claude guard denies only a safety refusal; a write with contract findings is allowed with a warning, and a write the judge cannot run on is allowed and the failure logged. Codex and Hermes have no write hook. |

OMS has no host launcher and no `--runtime gjc` command path.

## Removed commands and operations

The 0.18 families `contract`, `note`, `link`, `bridge`, `index`, `graph`, `host`, `package`, `model`, and `status` were removed in 0.19. Typing one exits 1 and prints its replacement; none is an alias. The older retired names `template`, `audit`, `reconcile`, `linkify`, `embed`, `doc`, `mcp`, `lint`, `install`, `uninstall`, and `update` behave the same way. The hook leaf `pre-tool-use` is retired in favour of `oms hook pre`.

The MCP `link` and `status` tools were removed in 0.19: link suggestion is `oms_search` with `op: "link"`, link checking is `oms_doctor` with `op: "link-check"`, and status is `oms_doctor` with `op: "status"`. Removed MCP operation aliases are `lazy-load`, `multi-get-documents`, and the standalone search operations `collections`, `contexts`, and `status`. The `write` tool accepts no `op`.
