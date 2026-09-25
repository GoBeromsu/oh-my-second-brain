# Architecture

Oh My Second Brain is an Obsidian-first vault integration. It keeps the vault as plain Markdown the user owns, and it separates that meaning from generated runtime data. Obsidian remains usable when OMS is absent. OMS does not become the note store, and one example does not become a required rule.

These pages record the approved architecture. They are not a host-smoke result and not a product-gate pass. The text figure below is a repository sketch. It is not the G002 Excalidraw artifact, which has to be drawn in the bound vault and checked by save, reload, and render.

## Authorities and derived state

```text
property pool (type, format, intent)
        │
        ▼
always-on common contract
        │  an explicitly registered template may add, tighten, or relax
        ▼
registered user-owned Markdown source (path and content hash)
        │
        ├── .oms/taxonomy.json          placement, folder meaning, link meaning
        ├── .obsidian/types.json        read-only observation, not the contract
        └── .oms/types.json             historical v4 projection, not authority
```

Version 5 of `.oms/template-policy.json` is the published structural authority. The pool holds each property's type, intent, and any format or value policy. The always-on common contract and every explicitly registered template point at pool properties. A registration inherits the common contract and may add to it, tighten it, or relax it where that relaxation was approved for the template. A closed value set exists only when the declaration sets `valuePolicy: "closed"`; `allowedValues` alone is a suggestion. A reference to a missing pool property is a dangling field.

The common contract is always on and has no Markdown file of its own. OMS declares no field or heading for it, so it holds exactly what the published document says: nothing until the user writes fields into it, and whatever they write from the first revision onward. A note that selects no registered template is valid under that common contract. A registration can add fields or headings and can adjust inherited requirements within its published contract. Extra body text and descendant headings stay free. OMS does not hardcode property names, folder names, personas, or the meaning of a heading.

Unmanaged frontmatter is preserved and left unchecked. OMS does not insert required values, rewrite a source into a note, or apply a naming expression on the user's behalf.

The policy contains no approved Markdown bytes, managed drafts, or `.oms/templates/` directory. Each registration records the path and content hash of the user's own Markdown source; OMS never rewrites, copies, or snapshots that source. A changed hash is source-drift evidence, not approval, identity, or authentication. The agent may interpret Templater or another source syntax. OMS does not parse or execute `tp`, JavaScript, or a private token, and it does not infer a contract from those tokens.

`.oms/taxonomy.json` decides placement and what folders and links mean. It does not decide a template's keys. Destination precedence is an explicit note path or folder, then that template's placement, then a question. There is no Inbox guess. Folder and wikilink axes stay available regardless of where a note is placed.

`.obsidian/types.json` is a read-only observation. A conflict with it is a separate diagnostic. It does not replace the version-5 contract, and OMS does not write the file.

`.oms/types.json` is a historical version-4 projection. Version 5 neither derives nor reads it, and nothing regenerates it. It is not semantic authority.

The selected-contract binding records the published contract revision, the selected template when there is one, the referenced property contract, and the registered source identity, path, and hash. An unrelated registration change does not alter another selection's binding.

A historical version-3 or version-4 policy remains readable. Only a mutating selection migrates it in place, preserving its recorded meaning. A held or unproved historical contract is reported as `review-required`, rather than rewritten. The retired `concept` identity and bundled defaults are not a reason to drop ontology: meaning remains data the user owns.

Template contracts are recorded in ADR-007 (Accepted; implementation in progress), which replaces the former ADR-013 through ADR-016; until it is implemented, the code still follows the former ADR-015 version-5 policy. [ACKNOWLEDGMENTS](../ACKNOWLEDGMENTS.md) records the debt to Ouroboros for an explicit contract and a split between writing and evaluation, and to Gajae Code's deep-interview for one confirmed question at a time. Neither credit is a code port or a measured research claim.

## Guide, write, and check

The agent writes and repairs the note with ordinary file tools. OMS does not write that file.

`guide` selects the contract for one explicit new or existing note path and returns a session locator. An unset path is a question. That question does not issue a session. `check` reads the saved bytes through that locator and reports declared properties and headings with `semantic: "not-evaluated"`. It does not accept an unsaved body or a caller PASS. OMS has no completion operation or reviewer handshake; deciding whether a note is worth keeping and repairing it belongs to the user and agent.

A selection locator identifies the saved selection session for the explicit note path. It is not authentication, user approval, or proof that a source was reviewed. No secret, daemon, or journal is required to select or check a contract.

The structural check reads the saved note and revalidates the selected published contract and registered source. Note text is untrusted data, not new instructions. OMS does not fetch external references as part of this check.

Structural results do not evaluate the note's semantic quality. A declared property or heading result is not a completion verdict, and OMS does not claim that the whole vault stayed unchanged, that a hook blocked a save, or that a tool sandbox was enforced.

OMS adds no model provider, reviewer daemon, or repair workflow. A search or check call does not grant permission to alter a note. The engine store, graph cache, and node index live outside the vault and are rebuildable. See [conventions](./conventions.md).

## Drift, publication, and search

Source drift is reported for the affected registration. Source review is read-only; acknowledge-source advances only the recorded hash using the live reviewed digest, and relink-source requires a genuinely missing original and an exactly named candidate path. Other registered templates stay usable.

An absent, unreadable, malformed, or historical policy is reported as its own state; an unreadable control is never substituted with an empty contract. `CONTRACT_POLICY_UNREADABLE`, `TEMPLATE_POLICY_UNREADABLE`, and `TEMPLATE_TAXONOMY_UNREADABLE` distinguish unreadable controls from absent and empty ones. An in-progress or torn contract transaction stops the affected selection or check. It does not stop search. Publication is not claimed to make several files atomic. The transaction marker and generation check are what reject a torn read. An interrupted publish is resumed or reported from the staged and published bytes. Notes are not rolled back.

Invalid publication metadata reports a bounded failure reason and a vault-relative control path through doctor and contract-loading errors. Invalid metadata is not treated as a known resumable transaction. Unsupported policy versions and invalid markers are independent failures; neither permits automatic policy conversion, marker deletion, or approval of a repair.

Only contract publication uses a verified target and compare-and-swap against the exact policy bytes now on disk. `oms template publish --policy <file.json> --transaction-id <uuid> [--yes]` previews before `--yes`; a valid hand-edited policy remains revisable. Its only outputs are the policy and one history record, beginning at revision 0. Original sources, Obsidian type files, `.oms/types.json`, and ordinary notes are not publication outputs. `oms setup` writes portable `.oms/settings.json` identity and the approved host connection, and can select a model in the same pass; it publishes no contract. The leaves are in [the CLI map](./cli-map.md) and the host boundary is in [the host asset contract](./adapters.md).

Lexical search does not need `.oms/types.json`. Lexical, vector, HyDE, and typed-axis queries include unbound, invalid, and incomplete notes. Registered template sources stay out of ordinary note results. Search does not read the retired projection; an unreadable search control leaves search available with a named reason instead of an empty result set. Vector, HyDE, and rerank requests fail loudly when their provider and model pair is missing or unusable. Those failures are not replaced with an empty success or another backend. That is the ADR-005 boundary. Search does not write notes, start an interview, or repair anything.

`status` reports observation, including source and contract state as separate facts. `doctor` diagnoses controls and indexes. Its repairs are explicit managed-state repairs after verified-target admission. Note backfill is not a repair. Target precedence and admission are in [verified targets](./verified-target.md).

## Public surfaces

The CLI does not require a host. The three public sets stay independent:

| Set | What it is |
| --- | --- |
| Eight skills | `distill`, `doctor`, `interview`, `link`, `search`, `status`, `template`, `write`. Host workflows. `interview` and `template` are tool-less. |
| Five MCP tools | `write`, `search`, `link`, `status`, `doctor`, from `oms serve mcp`. A subset of the skills. |
| Fourteen CLI families | `setup`, `template`, `note`, `link`, `bridge`, `search`, `index`, `graph`, `host`, `package`, `model`, `serve`, `hook`, `status`. Not the skill list and not the tool list. |

Leaves, discriminators, and removed operations are only in [the CLI map](./cli-map.md). `bridge` is the repository-to-vault target. `link` suggests and checks note wikilinks and does not apply them. `package update` does not sync hosts. `oms serve mcp` and `oms serve http` do not create a vault engine store by starting.

### MCP namespace boundary

The MCP server id is `oms`. Local tool names are `write`, `search`, `link`, `status`, and `doctor`. Qualifying hosts therefore display `oms_write`, `oms_search`, `oms_link`, `oms_status`, and `oms_doctor` exactly once, never `oms_oms_*`. Raw MCP clients call the local names.

Directly under `src`, the five top-level entries are still assets, cli, kernel, mcp, and vendors. This cutover adds no sixth and no sixth MCP tool. The skill, tool, and command names above are the approved public surface. A build that still accepts a retired note, link, or template operation has not finished the cutover. That behavior is not a compatibility path.

See [conventions](./conventions.md) for vault data and [installation](./install.md) for host setup.
