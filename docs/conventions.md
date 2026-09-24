# Vault conventions

The vault is the user's plain Markdown. Obsidian can open it with no OMS process. OMS does not own the notes, and it does not hardcode property names, folders, or personas. Ontology is the user's statement of what a field, folder, or link means. The retired piece is `concept` as note identity and a bundled default shape, not that statement of meaning.

ADR-014 is the successor of ADR-013. [ACKNOWLEDGMENTS](../ACKNOWLEDGMENTS.md) credits Ouroboros and Gajae Code's deep-interview as acknowledged design ideas, not ported code and not a research result. This page is approved architecture. It is not a host-smoke result.

## Where meaning lives

| Path | Role |
| --- | --- |
| Vault Markdown notes | User-owned plain Markdown. The agent writes and repairs them. OMS does not write note bytes. |
| `.obsidian/types.json` | Read-only Obsidian observation. OMS never writes it. A type conflict is a diagnostic. The version-4 contract still decides. |
| `.oms/template-policy.json` | Version 4, the only approved structure and meaning. Holds the property pool, the always-on default, optional individual templates, approved Markdown, and completion policy. |
| `.oms/templates/default.md` | Editable managed draft of the default layer. It starts empty. Approved bytes live in the policy snapshot, not in whatever the draft says today. |
| `.oms/templates/<id>.md` | Editable managed draft of one individual template. |
| `.oms/taxonomy.json` | Placement, folder meaning, and link meaning. Not a property-type file and not the list of template keys. |
| `.oms/types.json` | Derived `oms.types.v2` projection (`generatedFrom` names the snapshot). Not semantic authority. Never hand-edit it. |
| `.oms/template-transaction.json` | Marker for contract publication. Not a note and not a second policy. |
| `.oms/engine-store.sqlite` | Runtime index. Do not commit it. |
| Runtime journal | Outside the vault, under `~/.oms/runtime/v1` unless `OMS_RUNTIME_ROOT` is set. Digests and outcomes only. Not completion authority. Do not commit it. |

These files are not interchangeable. The pool says what a property is and what it means. The default layer says which of those properties, headings, and criteria apply to every note. An individual template may add more, or tighten allowed values and heading order. It may not remove or weaken the default. Taxonomy says where a note goes and what a folder or wikilink means. Obsidian's type file is evidence OMS may read. The derived projection is a cache of the effective contract for retrieval and maintenance.

A note with no individual template is valid. Unmanaged frontmatter is preserved and is not checked. OMS does not fill in required values, convert a source file into the note, or expand a naming expression.

Approved Markdown is stored as exact UTF-8, including a BOM and the file's line endings. A later edit to the managed draft or to an original template source is local drift. Guide and check keep the last approved snapshot and warn for that template only. The edit is not a new approval. OMS does not parse or execute Templater, JavaScript, or a private token, and it does not infer headings or fields from those tokens. The agent may interpret a source. The approved policy is the contract.

Version 3 fields are unsupported. There is no migration, no compatibility reader, no note renderer, and no note-write, link-apply, or backfill path that keeps the old contract alive.

## Placement

Taxonomy does not choose a template's keys. Resolve a destination from an explicit note path or folder, then the template's placement, then a question. There is no Inbox fallback. A taxonomy folder is a note destination. It does not have to sit inside a template source folder. Folder and wikilink relationships remain global axes, so retrieval is not limited to one placement rule.

Changing placement policy is a contract change. It goes through the config interview, not through a note write.

## How a contract change is approved

Do not hand-edit policy, taxonomy, or `.oms/types.json` to change meaning. The tool-less `interview` skill reads intent the user already wrote, asks one question at a time, and publishes only the approved diff by compare-and-swap. The tool-less `template` skill shapes that contract. It does not render a note.

`oms setup` proposes an empty version-4 policy for a vault that does not have one yet. It ships no bundled note shape and never modifies notes. Model install, selection, waiver, and status are `oms model` leaves, not setup-era model flags.

The leaves are `oms template list`, `show`, `scan`, `check`, `publish`, `review-sources`, `acknowledge-source`, and `relink-source`. The first four read. `publish` runs only after the user approves the revision it previewed, and the source leaves run only with explicit confirmation. Publish outputs are the policy and one history record. The user's own template sources, `.obsidian/types.json`, and ordinary notes are not outputs.

The first host notice for a selected-source change names no template and shows no hash or change class. The exact sentence and the two buttons are in the [host asset contract](./adapters.md). Deferring does not call the server. Confirming starts the interview. It does not rewrite source bytes and it does not block search. A general question, an unknown note value, a failed check, an unmanaged property, or a search does not start the interview.

If the approved snapshot is missing, damaged, or its digest does not match, that evaluation stops. OMS does not replace it with an empty contract. An in-progress publication stops guide, check, and complete for the affected work and leaves search running. Interrupted publication is distinguished from the bytes actually staged or published. Notes are not rolled back. Multi-file publication is not claimed to be atomic.

`completion.retryBudget` and `agentRepair` live on the policy as operation settings. They are not part of the contract digest. Repair is off by default. The budget is a finite nonnegative integer the user sets, default 2, and 0 is allowed. There is no fixed product cap of 3.

## Notes, search, and what may be committed

The agent writes the note after `guide` and before `check`. `complete` follows a separate review of the saved inputs. Those three operations read the note. They do not render it and they do not backfill it. Create, append, update, and backfill are not note operations. Link leaves are suggest and check. Link apply is not an operation.

`oms search query <text>` is plain lexical search and does not need `.oms/types.json`. `--vec`, `--hyde`, G004 `--expand`, and `--rerank` are explicit channels. `--max-queries` accepts only integers from 1 through 32. Lexical, vector, HyDE, and typed-axis queries include unbound, invalid, and incomplete notes. Managed sources do not appear as ordinary note results. A missing or stale projection fails a typed axis loudly. Vector search requires `OMS_EMBEDDING_PROVIDER` and `OMS_EMBEDDING_MODEL`. HyDE also requires `OMS_GENERATE_PROVIDER` and `OMS_GENERATE_MODEL`. Reranking requires `OMS_RERANK_PROVIDER` and `OMS_RERANK_MODEL`. An incomplete pair fails loudly. G004 expansion makes no replacement, parity, or outperformance claim. Search does not write notes and does not start a review. This is the ADR-007 rule, not a new backend.

`oms template check` diagnoses the published contract, its portable settings, and each registered source. `oms note audit` reports note-contract diagnosis. `oms template publish` publishes one explicit contract revision after a verified target and the user's confirmation. Index and graph maintenance are `oms index sync`, `oms index embed`, `oms index repair`, `oms index clean`, and `oms graph build`. `oms index status` is read-only. The `status` skill, `oms status`, and the `status` MCP tool are read-only and do not decide completion. Note backfill is not a repair.

Every leaf and discriminator is in [the CLI map](./cli-map.md). Admission is in [verified targets](./verified-target.md). The authority rationale is in [architecture](./architecture.md).

`.oms/template-policy.json`, `.oms/taxonomy.json`, approved managed drafts, and the derived `.oms/types.json` may be committed with the notes they govern. Commit the policy if you want the approved meaning in git. Do not treat a dirty managed draft as that approval. `.oms/engine-store.sqlite` and the external runtime journal must not be committed.
