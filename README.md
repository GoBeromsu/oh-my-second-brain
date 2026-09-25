# Oh My Second Brain

Oh My Second Brain (`oms`) connects an existing Obsidian or Markdown vault to AI hosts without taking ownership of its notes. The vault remains plain Markdown. Obsidian stays the command center: the notes are still files a person can read and edit when OMS is not running. OMS does not invent the meaning of a property, a folder, or a heading.

## Vault contract

Meaning stays with the user. The user seals the vault's contract once, in an interactive `oms setup` run at a terminal. The interview covers three parts together: folders (what each folder means and what may be placed there), the property pool (each property's type and intent), and templates (what each template in the template folder declares). The product hardcodes no property names, folders, or personas, and it has no Inbox fallback.

The sealed contract lives outside the vault, under `~/.oms/vaults/<vault-id>/`. The only OMS file inside the vault is `.oms/settings.json`, which holds `version`, `vaultId`, `templateFolder`, `embedding`, and `agentRepair`. Any other entry in `.oms/` is reported by `oms contract doctor` as an unexpected control file and is otherwise ignored. `.obsidian/types.json` is a read-only observation and never overrides the seal.

A template stays the user's own Markdown file in `templateFolder`. Sealing records what it declares; OMS never rewrites, copies, or applies it. `oms contract status` reports each sealed template as `active`, `drift`, or `missing` against the live file. A drifted template is reported, never re-sealed silently; the user re-seals it with `oms setup`. OMS does not parse or execute Templater, JavaScript, or a private token language.

The agent writes notes. One judge decides every write against the seal. A denied write leaves the file unchanged and returns only `{field, kind}` violations and one guidance command, never a rule value, a store path, or the contract body. A vault with no seal on this machine is not judged. When this machine holds seal evidence that no longer matches the vault, writes are refused as `contract-unreadable` until the user runs `oms setup` again. OMS has no completion call and no reviewer conversation: an allowed write means the note fits the sealed structure, not that it is worth keeping.

The vault contract is recorded in ADR-007 (`docs/decisions/` in the source repository), which replaces the former ADR-013 through ADR-016. [ACKNOWLEDGMENTS](./ACKNOWLEDGMENTS.md) credits Ouroboros and Gajae Code's deep-interview as design ideas. Those credits are not a copied runtime and not a research result. Diagrams in this repository are explanatory sketches. These pages record the approved architecture. They are not a host-smoke result and not a product-gate pass.

The authority model is in [architecture](./docs/architecture.md). Vault files are in [conventions](./docs/conventions.md). Leaves are in [the CLI map](./docs/cli-map.md).

## Setup

`oms setup` is the same command as `oms contract setup`. It interviews the whole vault and seals the contract. It writes only `.oms/settings.json` inside the vault and never modifies notes. It refuses to run without an interactive terminal or under `OMS_NON_INTERACTIVE=1`, so an agent never runs it. Run it again at any time to re-seal.

```bash
oms setup --vault /path/to/vault
oms contract status --vault /path/to/vault
```

`oms contract extract --template <path>` shows what one template declares without printing values. `oms contract doctor` diagnoses the seal, stale locks, orphaned generations, unexpected control files, and hook transport failures; `--fix` only re-indexes a moved or unindexed vault. Any other broken seal is recovered by running `oms setup` again. Model lifecycle stands alone as `oms model install|select|waive|status`.

## CLI

```text
oms bridge add|remove|status                   Manage repository-to-vault target bridges
oms contract setup|extract|status|doctor       Seal the vault contract, or inspect and diagnose it
oms graph build|status                         Build or inspect the note graph
oms hook pre                                   Judge a Claude write against the vault contract
oms host install|remove|sync|status            Manage host assets and MCP registrations
oms index sync|embed|repair|status|clean       Manage derived search state
oms link suggest|check                         Suggest or check note wikilinks
oms model install|select|waive|status          Manage local model selection
oms note audit|get                             Audit notes against the contract, or read them
oms package check|update                       Check or update the OMS package
oms search query|context                       Run an explicit query or retrieve structured context
oms serve mcp|http                             Start the stdio MCP or local HTTP server
oms setup                                      Interview the vault and seal its contract
oms status                                     Show the read-only aggregate status
```

`oh-my-second-brain` is the full command; `oms` is its short alias. These fourteen families, the six skills, and the five MCP tools are three different sets. The leaf map is [the CLI map](./docs/cli-map.md).

### Help contract

Every recognized command accepts `--help` and `-h`, exits 0, and performs no side effects. An unknown command combined with `--help` exits 1.

A plain `oms search query <text>` is lexical-only. `--vec` and `--hyde` select their respective channels; `--expand` explicitly enables G004 expansion, `--max-queries` accepts an integer from 1 through 32, and `--rerank` is opt-in. `oms search context` is the separate structured-context surface. Embedding is `oms index embed`; sync and repair are distinct index modes. `oms index status --view status|collections|contexts` preserves all three read-only views, while `oms index clean` removes eligible derived state.

Lexical, vector, HyDE, and typed-axis queries still include notes that would fail the contract. A missing or damaged contract does not stop search. Vector search requires a complete `OMS_EMBEDDING_PROVIDER`/`OMS_EMBEDDING_MODEL` pair. HyDE also requires `OMS_GENERATE_PROVIDER`/`OMS_GENERATE_MODEL`. Reranking requires `OMS_RERANK_PROVIDER`/`OMS_RERANK_MODEL`. Missing, incomplete, or uninstalled selections fail loudly. G004 expansion is an explicit available capability; it makes no replacement, parity, or outperformance claim.

`oms note audit` judges existing notes against the seal and reports `{path, field, kind}` entries; it never rewrites a note. Create, append, update, and backfill are retired note operations. Link apply is not an operation. There is no note renderer or compatibility path for retired operations.

## MCP tools

`oms serve mcp` exposes exactly five public tools:

`write` · `search` · `link` · `status` · `doctor`

The six skills (`distill`, `doctor`, `link`, `search`, `status`, `write`) are host workflows. `distill` is tool-less.

The five tools are a subset of those skills, and neither set is the fourteen CLI families. Detail capabilities remain `op` values under the five tools. Sealing has no MCP operation and no skill.

`write {path, content, template?}` judges the whole note and saves it only when it is allowed. `template` is optional and names the sealed template the note follows. `status` and every search operation are read-only. The `doctor` tool validates the seal, audits notes, and runs explicit index maintenance; it does not backfill notes. Claude's native Write, Edit, MultiEdit, and NotebookEdit inside the vault reach the same judge through `oms hook pre`; Codex and Hermes have no write hook, so their notes are judged only through MCP `write`.

## Install

Node.js 20 or later is required.

```bash
npm install -g oh-my-second-brain
oms host install --runtime all --vault /path/to/vault --yes
```

For Gajae-Code, install the npm package as a marketplace plugin: `gjc plugin install oms@oms`. GJC discovers the six OMS skills at the package-root `skills/` convention path.

Host installation records the canonical vault in `${XDG_CONFIG_HOME:-~/.config}/oms/vault.json` and stamps `oms serve mcp --vault /path/to/vault` into each managed host entry. `oms host install|remove|sync|status` use that signed pointer only to maintain host integrations. `oms package update` updates the package but never syncs hosts implicitly; run `oms host sync` separately.

Runtime target resolution never reads the host-maintenance pointer. Its precedence is explicit target, local vault controls, bridge, `OMS_VAULT`, then the current directory only as a safe read-only fallback. Sealing, note writes, and derived-state repair cannot use that fallback.

`OMS_VAULT` is the supported environment fallback when no explicit, local, or bridge target exists.

See [installation](./docs/install.md), [architecture](./docs/architecture.md), [conventions](./docs/conventions.md), [the CLI map](./docs/cli-map.md), [host assets](./docs/adapters.md), and [verified targets](./docs/verified-target.md).
