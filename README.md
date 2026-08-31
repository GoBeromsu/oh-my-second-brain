# Oh My Second Brain

Oh My Second Brain (`oms`) makes an existing Obsidian or Markdown vault available to AI hosts without taking ownership of its notes. The vault's own Markdown templates define managed note shape and body; OMS provides safe setup, writing, search, diagnosis, and host integration.

## Template-first vault model

- Vault-resident Obsidian `.md` templates are the authority for managed note shape and body.
- Every managed template has a stable `templateId`, independent of its path or content digest.
- A single BaseContract is inherited by each managed TemplateContract.
- `.obsidian/types.json` is read-only type authority.
- `.oms/template-policy.json` defines template semantics, naming, and defaults.
- `.oms/types.json` is a validated derived projection for writing and search. Do not hand-edit it.
- Taxonomy supplies placement; folders and wikilinks remain global retrieval axes.

## Setup and template changes

`oms setup` recursively discovers existing templates and proposes a migration. It does not modify notes and ships no bundled defaults. Review the dry run, then repeat the operation with its exact approved digest:

```bash
oms setup --vault /path/to/vault --dry-run
oms setup --vault /path/to/vault --approved-digest <digest>
```

Managed-template mutations use the same dry-run, explicit approval, compare-and-swap, and transaction-receipt boundary.

## Operations

Writes resolve a `ResolvedTemplate` and support `create`, `append`, and `update` modes. The verified-target admission check runs before any mutation; successful writes return receipts.

Search is lexical and does not depend on the derived projection. It can narrow by managed template, declared field, folder, or link. Managed sources are excluded from ordinary results. Vector behavior is never fabricated: unavailable vector capability is reported rather than simulated.

`oms doctor` diagnoses, regenerates projections, and backfills where applicable; repair operations require a verified target. `oms status` is read-only.

## Hosts, skills, and MCP

OMS is usable independently through the CLI. Installable host surfaces live in [`assets/`](./assets/), including six public skills: `write`, `search`, `link`, `distill`, `status`, and `doctor`.

`oms mcp` exposes five public MCP tools:

`oms_write` · `oms_search` · `oms_link` · `oms_status` · `oms_doctor`

The skills guide host behavior; MCP tools are the transport API. They are distinct public surfaces.

## Install

Node.js 20 or later is required.

```bash
npm install -g oh-my-second-brain
oms install --runtime all --vault /path/to/vault --yes
```

Host installation registers `oms mcp --vault /path/to/vault`. It stamps that explicit vault argument only; it does not change runtime target-resolution precedence. See [installation](./docs/install.md), [architecture](./docs/architecture.md), [conventions](./docs/conventions.md), and [verified targets](./docs/verified-target.md).
