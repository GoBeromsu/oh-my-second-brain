# Architecture

Oh My Second Brain is an Obsidian-first vault integration. It keeps the vault as plain Markdown the user owns, and it separates that meaning from generated runtime data. Obsidian remains usable when OMS is absent. OMS does not become the note store, and one example does not become a required rule.

These pages record the approved architecture. They are not a host-smoke result and not a product-gate pass. The text figure below is a repository sketch. It is not the G002 Excalidraw artifact, which has to be drawn in the bound vault and checked by save, reload, and render.

## Authorities and derived state

```text
property pool (type, format, intent)
        │
        ▼
always-on default layer, initially empty
        │  an individual template may only add or tighten
        ▼
approved Markdown snapshot (exact UTF-8, including BOM and EOL)
        │
        ├── .oms/taxonomy.json          placement, folder meaning, link meaning
        ├── .obsidian/types.json        read-only observation, not the contract
        └── .oms/types.json             derived oms.types.v2, not authority
```

Version 4 of `.oms/template-policy.json` is the only approved structure and meaning. The pool holds each property's type, intent, and any format or allowed values. The default layer and each individual layer point at a pool property. A layer may mark a field required or narrow allowed values. It cannot override type, format, or intent, and it cannot make a default requirement optional. An empty intersection or a conflicting declaration is a composition conflict, not a silent overwrite. A reference to a missing pool property is a dangling field.

The default layer is always on. It starts with empty fields, headings, and criteria, and with empty approved Markdown. A note that selects no individual template is valid under that default. An individual template adds fields, headings, or semantic criteria, or it tightens heading order. Extra body text and descendant headings stay free. The same criterion id cannot carry two statements; a stronger criterion is a new id. OMS does not hardcode property names, folder names, personas, or the meaning of a heading.

Unmanaged frontmatter is preserved and left unchecked. OMS does not insert required values, rewrite a source into a note, or apply a naming expression on the user's behalf.

Each layer stores `approvedMarkdown` as the exact approved UTF-8 bytes, including BOM and line endings, plus the digest of those bytes. `.oms/templates/default.md` and `.oms/templates/<id>.md` are editable managed drafts. After a local edit, guide and check keep using the last approved snapshot and report drift for that template only. Editing a draft or an original source does not approve new meaning. The agent may interpret Templater or another source syntax. OMS does not parse or execute `tp`, JavaScript, or a private token, and it does not infer a contract from those tokens.

`.oms/taxonomy.json` decides placement and what folders and links mean. It does not decide a template's keys. Destination precedence is an explicit note path or folder, then that template's placement, then a question. There is no Inbox guess. Folder and wikilink axes stay available regardless of where a note is placed.

`.obsidian/types.json` is a read-only observation. A conflict with it is a separate diagnostic. It does not replace the version-4 contract, and OMS does not write the file.

`.oms/types.json` carries `oms.types.v2`: effective fields, headings, and axes, plus the `generatedFrom` digest of the snapshot that produced them. It is a projection for retrieval and maintenance. It is not approved Markdown and not semantic authority. Do not hand-edit it.

The contract digest covers the default layer, the selected individual template when there is one, the pool entries those layers reference, and the placement that applies. An unrelated template change does not stale another note's task. `completion.retryBudget` and `agentRepair` sit outside that digest, so changing the repair budget does not pretend the approved contract changed.

Version 3 is unsupported. There is no automatic migration, no compatibility reader, no note renderer, and no note-write, link-apply, or backfill compatibility path. The retired `concept` identity and bundled defaults are not a reason to drop ontology: meaning remains data the user owns.

ADR-014 is the successor of ADR-013. [ACKNOWLEDGMENTS](../ACKNOWLEDGMENTS.md) records the debt to Ouroboros for an explicit contract and a split between writing and evaluation, and to Gajae Code's deep-interview for one confirmed question at a time. Neither credit is a code port or a measured research claim.

## Guide, write, check, review, complete

The agent writes and repairs the note with ordinary file tools. OMS does not write that file.

`guide` returns approved Markdown, the effective contract, and the task binding for a chosen new or existing path. An unset path is a question. That question does not issue a check task. `check` reads the saved note, the controls, and the declared evidence from disk. It does not accept an unsaved body or a caller PASS. The host then launches a separate reviewer. `complete` accepts that reviewer's structured result and reads the same inputs again.

A task binding is the canonical tuple of schema version, vault fingerprint, template id or null, note path, contract digest, and rubric digest. The task id is the hash of that tuple. The same snapshot reproduces the same id after a CLI, MCP, or host restart. That is content integrity. It is not authentication, a user approval, or proof that a reviewer ran. No secret, daemon, or journal is required to recompute it.

The review-request digest binds the task, the note, the contract, the rubric, the target ids, the evidence manifest, and the reviewer prompt. `check` and `complete` recompute it. Note text and evidence text are untrusted data, not new instructions. An external reference stays unverified: OMS does not fetch it during `complete`, and it cannot satisfy a criterion that requires bytes.

Completion requires the machine result, a pass on every required criterion, a real separate review, and the same scoped inputs before and after that review. A machine pass alone does not complete the task. A PASS string from the writing role, a missing criterion, a missing rubric, or a failed launch does not either. Agreement of the reviewed inputs is not a claim that the whole vault stayed unchanged, that a hook blocked a save, or that a tool sandbox was enforced.

Instruction-only review is valid: another role or conversation, a non-modification instruction, the request digest, a terminal result, and those matching inputs. A byte-for-byte match between a shipped reviewer file and an installed copy shows only that those bytes match. It does not show that the host loaded the file or launched the role. OMS does not certify reviewer independence. The host launches the reviewer. OMS adds no model provider and runs no reviewer daemon. The host-specific boundary is the [host asset contract](./adapters.md).

Agent repair is off unless the user sets `agentRepair.enabled` and names post-write or explicit maintenance. A search or check call does not grant that permission. `completion.retryBudget` is the user's finite nonnegative integer, default 2, and 0 is allowed. There is no separate product cap. The host counts attempts. OMS checks the attempt chain it is shown. A receipt is not a signature, and it does not prove that unseen retries did not happen. Budget exhaustion or cancellation waits for the user. OMS does not weaken the contract to force a pass.

The runtime journal, outside the vault, may record digests and outcomes. It is not validity authority. A journal write failure is a warning, not a change to the verdict. See [conventions](./conventions.md).

## Drift, publication, and search

Source drift and managed-draft drift are warnings for that template. Guide and check continue with the last approved contract and Markdown. Other templates stay usable.

A missing, damaged, or digest-mismatched approved policy is unverifiable. OMS does not substitute an empty contract. An in-progress or torn contract transaction stops `guide`, `check`, and `complete` for the affected evaluation. It does not stop search. Publication is not claimed to make several files atomic. The transaction marker and generation check are what reject a torn read. An interrupted publish is resumed or reported from the staged and published bytes. Notes are not rolled back.

Only contract publication uses a verified target, the exact approved digest, and compare-and-swap. Its outputs are policy, taxonomy, the derived projection, and approved managed Markdown. Original sources, Obsidian type files, and ordinary notes are not publication outputs. Publishing a managed draft also requires the expected current digest, so an edit made after the interview is not overwritten. The config interview is the tool-less `interview` skill: one confirmed question at a time, then the exact diff. The initial notice is exactly `템플릿에 변경이 있습니다` with exactly `확인하기` and `나중에`, and it shows no template name, hash, or change class. `나중에` is host-only. `확인하기` starts the interview. A general question, an unknown value, a note error, an unmanaged property, or a search does not. The leaves and the fixed notice behavior are in [the CLI map](./cli-map.md) and the [host asset contract](./adapters.md).

Lexical search does not need `.oms/types.json`. Lexical, vector, HyDE, and typed-axis queries include unbound, invalid, and incomplete notes. Managed template sources stay out of ordinary note results. A missing, malformed, or stale projection fails a typed axis loudly. Vector, HyDE, and rerank requests fail loudly when their provider and model pair is missing or unusable. Those failures are not replaced with an empty success or another backend. That is the ADR-007 boundary. Search does not write notes, start an interview, or repair anything.

`status` reports observation, including source, contract, and reviewer state as separate facts. It does not decide completion. `doctor` diagnoses controls and indexes. Its repairs are explicit managed-state repairs after verified-target admission. Note backfill is not a repair. Target precedence and admission are in [verified targets](./verified-target.md).

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
