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
oms setup      Discover and adopt existing vault templates
oms install    Install host adapters and managed MCP registration
oms uninstall  Remove host adapters and managed MCP registration
oms update     Check/apply a package update and reconcile adapters
oms reconcile  Re-stamp hosts from the strict global vault pointer
oms doctor     Diagnose template authority and derived state
oms lint       Check broken [[wikilinks]] and orphan notes
oms search <text>  Plain lexical search; --vec, --hyde, --expand, --max-queries 1..32, and --rerank are explicit
oms embed      Generate embeddings for indexed notes
oms index sync|status|repair|cleanup|collections|contexts
oms doc get|multi-get
oms serve      Start the local search HTTP server
oms mcp        Start the stdio MCP server
oms hook       Run Claude pre/post tool-use vault guards
```

`oh-my-second-brain` is the full command; `oms` is its short alias.

### Help contract

Every recognized command accepts `--help` and `-h`, exits 0, and performs no
side effects. An unknown command combined with `--help` exits 1.

`oms search <text>` is lexical-only. `--vec` and `--hyde` select their respective
typed channels; `--expand` explicitly enables G004 expansion, `--max-queries`
accepts an integer from 1 through 32, and `--rerank` is opt-in. `oms embed` is
the sole embedding command; `oms index` has no embedding subcommand.

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

`oms mcp` exposes exactly five public tools:

`write` · `search` · `link` · `status` · `doctor`

The seven skills (`write`, `search`, `link`, `distill`, `status`, `doctor`, `template`) are workflow guidance, not a tool-equality list. Detail capabilities remain `op` values under the five tools.

Writes resolve one `ResolvedTemplate` and support create, append, and update. Template mutation, projection regeneration, and one-note identity backfill require a verified target and explicit approval digest. `status` and every search operation are read-only.

Plain lexical search is projection-independent. Typed template/declared-field/folder/link axes use the same projection as writes and fail loudly when it is missing or stale. Managed template sources are excluded. Vector and HyDE requests fail loudly unless both embedding provider and model are configured.

## Install

Node.js 20 or later is required.

```bash
npm install -g oh-my-second-brain
oms install --runtime all --vault /path/to/vault --yes
```

Host installation records the canonical vault in `${XDG_CONFIG_HOME:-~/.config}/oms/vault.json` and stamps `oms mcp --vault /path/to/vault` into each managed host entry. `install`, `update`, `reconcile`, and `uninstall` use that signed pointer only to maintain host stamps. Runtime write/search target resolution never reads it and keeps this precedence: explicit target, local vault controls, bridge, `OMS_VAULT`, then read-only cwd fallback.

`OMS_VAULT` is the supported environment fallback when no explicit, local, or bridge target exists.

See [installation](./docs/install.md), [architecture](./docs/architecture.md), [conventions](./docs/conventions.md), and [verified targets](./docs/verified-target.md).
