# Vault conventions

The vault is the user's plain Markdown. Obsidian can open it with no OMS process. OMS does not own the notes, and it does not hardcode property names, folders, or personas. Ontology is the user's statement of what a field, folder, or link means. The retired piece is `concept` as note identity and a bundled default shape, not that statement of meaning.

ADR-014 is the successor of ADR-013. [ACKNOWLEDGMENTS](../ACKNOWLEDGMENTS.md) credits Ouroboros and Gajae Code's deep-interview as acknowledged design ideas, not ported code and not a research result. This page is approved architecture. It is not a host-smoke result.

## Where meaning lives

| Path | Role |
| --- | --- |
| Vault Markdown notes | User-owned plain Markdown. The agent writes and repairs them. OMS does not write note bytes. |
| `.obsidian/types.json` | Read-only Obsidian observation. OMS never writes it. A type conflict is a diagnostic. The published contract still decides. |
| `.oms/template-policy.json` | Version 5, the published contract and the only structural authority. Holds the property pool, the always-on common contract, and each explicitly registered template with the path and content hash of the user's own Markdown source. |
| `.oms/settings.json` | Portable vault settings, including the vault UUID. It is not model configuration and not an identity authority. |
| `.oms/history/contracts/<revision>.json` | One record per published revision, publication, source acknowledgment, or relink. |
| Registered Markdown sources | The user's own files, anywhere in the vault. OMS records the path and hash and never rewrites, copies, or snapshots them. There is no managed draft and no physical file for the common contract. |
| `.oms/taxonomy.json` | Placement, folder meaning, and link meaning. Not a property-type file and not the list of template keys. |
| `.oms/types.json` | Historical version-4 projection. Version 5 neither derives nor reads it, and nothing regenerates it. |
| `.oms/template-transaction.json` | Marker for an in-flight publication. Not a note and not a second policy. |
| Engine store, graph cache, node index | Rebuildable caches outside the vault. Do not commit them. |
| Runtime journal | Outside the vault, under `~/.oms/runtime/v1` unless `OMS_RUNTIME_ROOT` is set. Digests and outcomes only. Not completion authority. Do not commit it. |

These files are not interchangeable. The pool says what a property is and what it means. The common contract says which of those properties and headings apply to every note. A registration inherits the common contract and may add to it, tighten it, or relax it where the user approved that relaxation for that template. A closed value set exists only where the document declares `valuePolicy: "closed"`; a list of allowed values on its own stays a suggestion. Taxonomy says where a note goes and what a folder or wikilink means. Obsidian's type file is evidence OMS may read.

A note with no registered template is valid under the common contract alone. Unmanaged frontmatter is preserved and is not checked. OMS does not fill in required values, convert a source file into the note, or expand a naming expression.

A registration records its source path and the content hash of the bytes the user reviewed. A later edit to that source is drift: guide and check keep using the published contract and report the drift for that registration only. A changed hash is evidence, not a new approval, and it is not identity or authentication. Acknowledging drift needs the live digest and advances only the recorded hash; relinking needs a genuinely missing original and a candidate path the user spells out exactly. OMS does not parse or execute Templater, JavaScript, or a private token, and it does not infer headings or fields from those tokens. The agent may interpret a source. The approved policy is the contract.

A historical version-3 or version-4 policy is still readable. Only a mutating selection migrates it, in place and preserving its recorded meaning; a held or unproved historical contract is reported `review-required` rather than rewritten. There is no note renderer and no note-write, link-apply, or backfill path.

## Placement

Taxonomy does not choose a template's keys. Resolve a destination from an explicit note path or folder, then the template's placement, then a question. There is no Inbox fallback. A taxonomy folder is a note destination. It does not have to sit inside a template source folder. Folder and wikilink relationships remain global axes, so retrieval is not limited to one placement rule.

Changing placement policy is a contract change. It goes through the config interview, not through a note write.

## How a contract change is approved

The tool-less `interview` skill reads intent the user already wrote, asks one question at a time, writes the explicit version-5 document, and publishes only what the user approved. Publication compare-and-swaps against the exact bytes now on disk, so a valid hand-edited policy stays revisable while a concurrent change is refused. OMS keeps no interview ledger: there is no question id, census digest, or server-issued approval digest. The tool-less `template` skill shapes that contract. It does not render a note.

`oms setup` describes the vault and points at `oms template publish` for a vault that has no published contract yet. It ships no bundled note shape and never modifies notes. Model install, selection, waiver, and status are `oms model` leaves, not setup-era model flags.

The leaves are `oms template list`, `show`, `scan`, `check`, `publish`, `review-sources`, `acknowledge-source`, and `relink-source`. The first four read. `publish` runs only after the user approves the revision it previewed, and the source leaves run only with explicit confirmation. Publish outputs are the policy and one history record. The user's own template sources, `.obsidian/types.json`, and ordinary notes are not outputs.

The first host notice for a selected-source change names no template and shows no hash or change class. The exact sentence and the two buttons are in the [host asset contract](./adapters.md). Deferring does not call the server. Confirming starts the interview. It does not rewrite source bytes and it does not block search. A general question, an unknown note value, a failed check, an unmanaged property, or a search does not start the interview.

If the published policy is missing, damaged, or unreadable, that evaluation stops and says which. An unreadable control is its own reported state, distinct from absent and from empty, and OMS never replaces it with an empty contract. An in-progress publication stops guide and check for the affected work and leaves search running. Interrupted publication is distinguished from the bytes actually staged or published. Notes are not rolled back. Multi-file publication is not claimed to be atomic.

## Notes, search, and what may be committed

The agent writes the note after `guide` and before `check`. Both read the note; neither renders or backfills it. `check` reports declared properties and headings and returns `semantic: "not-evaluated"`, so judging whether the note is worth keeping stays with the user and the agent. Create, append, update, backfill, and complete are not note operations. Link leaves are suggest and check. Link apply is not an operation.

`oms search query <text>` is plain lexical search and reads no contract at all. `--vec`, `--hyde`, G004 `--expand`, and `--rerank` are explicit channels. `--max-queries` accepts only integers from 1 through 32. Lexical, vector, HyDE, and typed-axis queries include unbound, invalid, and incomplete notes. Registered sources do not appear as ordinary note results. A missing or unreadable contract fails a typed axis loudly and names the reason instead of returning an empty set. Vector search requires `OMS_EMBEDDING_PROVIDER` and `OMS_EMBEDDING_MODEL`. HyDE also requires `OMS_GENERATE_PROVIDER` and `OMS_GENERATE_MODEL`. Reranking requires `OMS_RERANK_PROVIDER` and `OMS_RERANK_MODEL`. An incomplete pair fails loudly. G004 expansion makes no replacement, parity, or outperformance claim. Search does not write notes and does not start a review. This is the ADR-007 rule, not a new backend.

`oms template check` diagnoses the published contract, its portable settings, and each registered source. `oms note audit` reports note-contract diagnosis. `oms template publish` publishes one explicit contract revision after a verified target and the user's confirmation. Index and graph maintenance are `oms index sync`, `oms index embed`, `oms index repair`, `oms index clean`, and `oms graph build`. `oms index status` is read-only. The `status` skill, `oms status`, and the `status` MCP tool are read-only. Note backfill is not a repair.

Every leaf and discriminator is in [the CLI map](./cli-map.md). Admission is in [verified targets](./verified-target.md). The authority rationale is in [architecture](./architecture.md).

`.oms/template-policy.json`, `.oms/settings.json`, `.oms/taxonomy.json`, and the contract history may be committed with the notes they govern. Commit the policy if you want the published meaning in git. The engine store, the graph and node caches, and the external runtime journal are rebuildable and must not be committed.
