# Vault conventions

## Template-first authority

A managed note is defined by its vault-resident Obsidian Markdown template. The template owns its note shape and body; OMS does not provide a second, bundled default shape.

Each managed template has a stable `templateId`, independent of where its file is stored or what its current digest is. Every managed TemplateContract inherits one BaseContract. This makes identity stable while allowing a template's content to change through the approved mutation flow.

The vault's convention files have distinct roles:

| Path | Role |
| --- | --- |
| `.obsidian/types.json` | Read-only Obsidian type authority. OMS reads it but never writes it. |
| `.oms/template-policy.json` | User-controlled semantics, naming rules, and defaults for managed templates. |
| `.oms/types.json` | Validated derived projection used by write and search operations; never hand-edit it. |

Taxonomy decides template placement. Folders and wikilinks are global axes available to retrieval regardless of placement.

## Setup and migration

Run setup against the vault to discover templates recursively and inspect the migration it proposes:

```bash
oms setup --vault /path/to/vault --dry-run
```

The dry run changes neither templates nor notes. To apply the reviewed proposal, provide the digest it returned:

```bash
oms setup --vault /path/to/vault --approved-digest <digest>
```

Setup has no bundled defaults and never modifies vault notes. It writes only the explicit migration state approved for that vault.

## Managed template mutation

Do not hand-edit generated projection data. Change a managed template through the template operation flow instead:

1. Request a dry run.
2. Review its planned mutation and digest.
3. Apply with the exact approved digest.
4. Retain the transaction receipt.

The apply step uses compare-and-swap, so a template changed after review cannot be mutated by an obsolete approval.

## Writing notes

OMS resolves a `ResolvedTemplate` before writing. The available modes are:

- `create`: create a new note from the resolved template.
- `append`: add body content to an existing note.
- `update`: update an existing note according to the resolved template.

The runtime admits the target and operation before it mutates disk. The resolved template, mode preconditions, vault confinement, and target verification are all checked at that boundary. A completed operation returns a receipt; dry runs return the proposed result without changing the note.

## Search and maintenance

Search is lexical and independent of `.oms/types.json`. It can narrow results by managed template, declared field, folder, and wikilink. Managed sources do not appear as ordinary note results.

OMS does not invent vector results. When no supported vector capability is available, it reports that fact rather than returning simulated semantic matches.

Use `oms doctor` to diagnose state, regenerate derived projections, or backfill supported data. Repair is gated by the verified-target rule. Use `oms status` for read-only state reporting.
