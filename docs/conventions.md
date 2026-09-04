# Vault conventions

## Template-first authority

A managed note is defined by its vault-resident Obsidian Markdown template. The template owns note shape and body; OMS provides no bundled default shape.

Each managed template has a stable `templateId`, independent of its file location or current digest. Every managed TemplateContract inherits one BaseContract. Identity therefore remains stable while content changes through the approved mutation flow.

| Path | Role |
| --- | --- |
| Vault Markdown template | Frontmatter key scaffolding/default literals and body shape. |
| `.obsidian/types.json` | Read-only Obsidian type authority. OMS reads it but never writes it. |
| `.oms/template-policy.json` | User-owned note/field ontology (`intent`) plus naming rules and defaults. |
| `.oms/taxonomy.json` | User-owned folder/link ontology (`intent`) plus template placement. |
| `.oms/types.json` | Validated derived projection used by write and search operations; never hand-edit it. |

These authorities coexist: templates decide what a note contains, ontology explains what those fields, folders, and relationships mean, taxonomy places notes, and Obsidian decides property types. The removed legacy surface is `concept` as note identity and bundled runtime defaults—not ontology itself.

Taxonomy decides template placement. Folders and wikilinks are global axes available to retrieval regardless of placement; authored folder intents appear on the derived `folder-ontology` axis. A template without an explicit taxonomy placement writes to the safe `Inbox/` fallback, never into the configured template-source folder.

## Setup and migration

Run setup to discover templates recursively and inspect the proposed migration:

```bash
oms setup --vault /path/to/vault --dry-run
```

The dry run changes neither templates nor notes. Apply the reviewed proposal only with its reported digest:

```bash
oms setup --vault /path/to/vault --yes --approved-digest <digest>
```

Setup has no bundled note shapes and never modifies vault notes. When one legacy concept routes to multiple folders, migration materializes deterministic template IDs such as `literature--books`, copies the source bytes into separately managed templates, and keeps the clones on the same migrated contract.

## Managed template mutation

Do not hand-edit generated projection data. Change a managed template through the template operation flow:

1. Request a dry run.
2. Review its planned mutation and digest.
3. Apply with the exact approved digest.
4. Retain the transaction receipt.

The apply step uses compare-and-swap, so a template changed after review cannot be mutated by an obsolete approval.

## Register an existing template

For an existing vault template, call `write { op: "template", mode: "register-existing", templateId, sourcePath, contract, naming, dryRun: true }`, then repeat it with the returned `approvedDigest`. Registration reads and verifies the existing Markdown in place: it never copies, renames, moves, or rewrites the source. Markdown supplies structural shape only; author the named semantic contract in `.oms/template-policy.json` first. A later source edit is reconciled by `doctor { op: "regenerate-types" }`, which rebuilds generated `.oms/types.json` from current verified authorities.

## Writing notes

OMS resolves a `ResolvedTemplate` before writing. Available modes are:

- `create`: create a new note from the resolved template.
- `append`: add body content to an existing note.
- `update`: update an existing note according to the resolved template.

The runtime admits the target and operation before disk mutation. The resolved template, mode preconditions, vault confinement, and target verification are checked at that boundary. A completed operation returns a receipt; dry runs return the proposed result without changing the note.

## Search and maintenance

`oms search <text>` is plain lexical search and independent of `.oms/types.json`.
`--vec`, `--hyde`, G004 `--expand`, and `--rerank` are explicit opt-in channels;
`--max-queries` accepts only integers from 1 through 32. It can narrow by managed
template, declared field, folder, and wikilink. Managed sources do not appear as
ordinary note results.

OMS does not invent vector results. Vector search requires
`OMS_EMBEDDING_PROVIDER` and `OMS_EMBEDDING_MODEL`; HyDE also requires
`OMS_GENERATE_PROVIDER` and `OMS_GENERATE_MODEL`, while reranking requires
`OMS_RERANK_PROVIDER` and `OMS_RERANK_MODEL`. Missing or incomplete capability
pairs fail loudly rather than returning simulated matches. G004 expansion is
available only when explicitly selected and makes no replacement, parity, or
outperformance claim.

Use `oms doctor` to diagnose state, regenerate derived projections, or backfill
supported data. Repair is gated by the verified-target rule. Use `oms index
status` for read-only index state reporting; the `status` skill and `oms_status`
MCP tool remain read-only status surfaces.
