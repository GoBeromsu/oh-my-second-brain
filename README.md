# Oh My Second Brain

Oh My Second Brain (`oms`) connects an existing Obsidian or Markdown vault to AI hosts without taking ownership of its notes. The vault remains plain Markdown.

## Template and ontology vault model

- Actual vault-resident Obsidian `.md` templates own managed frontmatter shape and body scaffolding.
- Each template has a stable `templateId`, independent of its path and digest, and inherits one vault-wide `BaseContract`.
- `.obsidian/types.json` is read-only type authority.
- The user-owned ontology remains active: `.oms/template-policy.json` records note/field meaning alongside requiredness, formats, allowed values, defaults, naming, identity, and bindings.
- `.oms/taxonomy.json` records folder/link meaning and owns placement; authored folder intents are exposed through the `folder-ontology` search axis. It is the sole runtime authority; setup performs the one-time legacy YAML conversion.
- `.oms/types.json` is a validated derived write/search projection. Never hand-edit it.

The retired model is `concept` as note identity and bundled runtime defaults—not ontology as semantic meaning.

## Setup

Setup recursively discovers existing templates and proposes migration. It ships no note-type defaults and never modifies notes.

```bash
oms setup --vault /path/to/vault --dry-run
oms setup --vault /path/to/vault --yes --approved-digest <shown-digest>
```

Managed-template changes use the same dry-run, exact caller approval, compare-and-swap, transaction, and postcondition receipt boundary.

## CLI

```text
oms setup                                      Discover and adopt existing vault templates
oms template scan|list|show|add|update|move|remove|default|check|regenerate-types
oms note create|append|update|audit|backfill|get
oms link check|suggest|apply                   Check, suggest, or apply note wikilinks
oms bridge add|remove|status                   Manage repository-to-vault target bridges
oms search query|context                       Run an explicit query or retrieve structured context
oms index sync|embed|repair|status|clean       Manage derived search state
oms graph build|status                         Build or inspect the note graph
oms host install|remove|sync|status            Manage host assets and MCP registrations
oms package check|update                       Check or update the OMS package
oms model install|select|waive|status          Manage local model selection
oms serve mcp|http                             Start the stdio MCP or local HTTP server
oms hook pre|post                              Run pre- or post-tool-use vault guards
oms status                                     Show the read-only aggregate status
```

`oh-my-second-brain` is the full command; `oms` is its short alias.

`oms template add` has three forms: a folder registers its templates, a file
with `--id` registers that existing template, and `--id` with `--from` creates
one. The `--from` form writes to the registered `templateFolders[].default`
destination; that template folder does not constrain where notes are placed.
`oms template default <id>` declares the default binding. Creating a note
without an explicit template uses only that binding and otherwise fails with
`TEMPLATE_DEFAULT_UNDECLARED`; it never silently selects the first template.

### Help contract

Every recognized command accepts `--help` and `-h`, exits 0, and performs no
side effects. An unknown command combined with `--help` exits 1.

`oms search query <text>` is lexical-only. `--vec` and `--hyde` select their
respective typed channels; `--expand` explicitly enables G004 expansion,
`--max-queries` accepts an integer from 1 through 32, and `--rerank` is opt-in.
`oms search context` is the separate structured-context surface. Embedding is
explicitly `oms index embed`; sync and repair are distinct index modes.
`oms index status --view status|collections|contexts` preserves all three
read-only views, while `oms index clean` removes eligible derived state.

Vector search requires a verified local embedding capability, selected by a
complete `OMS_EMBEDDING_PROVIDER`/`OMS_EMBEDDING_MODEL` pair, the vault's
`.oms/models.json` plus its verified installed receipt, or a setup-installed
default. HyDE also requires a resolved generate capability; reranking requires
a resolved rerank capability. Their complete environment pairs are
`OMS_GENERATE_PROVIDER`/`OMS_GENERATE_MODEL` and
`OMS_RERANK_PROVIDER`/`OMS_RERANK_MODEL`. Missing, incomplete, or uninstalled
selections fail loudly. G004 expansion is an explicit
available capability; it makes no replacement, parity, or outperformance claim.
During setup, choose one local verified acquisition policy:
`--models-default`, `--models-descriptor <path>`, or `--models-no-default`.

## MCP tools

`oms serve mcp` exposes exactly five public tools:

`write` · `search` · `link` · `status` · `doctor`

The seven skills (`write`, `search`, `link`, `distill`, `status`, `doctor`, `template`) are workflow guidance, not a tool-equality list. Detail capabilities remain `op` values under the five tools.

Writes resolve one `ResolvedTemplate` and support create, append, and update. Template mutation, projection regeneration, and one-note identity backfill require a verified target and explicit approval digest. `status` and every search operation are read-only.

Plain lexical search is projection-independent. Typed template/declared-field/folder/link axes use the same projection as writes and fail loudly when it is missing or stale. Managed template sources are excluded. Vector and HyDE requests fail loudly unless both embedding provider and model are configured.

## Install

Node.js 20 or later is required.

```bash
npm install -g oh-my-second-brain
oms host install --runtime all --vault /path/to/vault --yes
```

For Gajae-Code, install the npm package as a marketplace plugin: `gjc plugin install oms@oms`. GJC discovers the seven OMS skills at the package-root `skills/` convention path.

Host installation records the canonical vault in `${XDG_CONFIG_HOME:-~/.config}/oms/vault.json` and stamps `oms serve mcp --vault /path/to/vault` into each managed host entry. `oms host install|remove|sync|status` use that signed pointer only to maintain host integrations. `oms package update` updates the package but never syncs hosts implicitly; run `oms host sync` separately.

Runtime write/search target resolution never reads the host-maintenance pointer.
Its precedence is explicit target, local vault controls, bridge, `OMS_VAULT`,
then cwd only as a safe read-only fallback. Mutations cannot use the cwd
fallback.

`OMS_VAULT` is the supported environment fallback when no explicit, local, or bridge target exists.

See [installation](./docs/install.md), [architecture](./docs/architecture.md), [conventions](./docs/conventions.md), and [verified targets](./docs/verified-target.md).
