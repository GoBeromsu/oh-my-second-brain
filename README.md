# Oh My Second Brain

Oh My Second Brain (`oms`) connects an existing Obsidian or Markdown vault to AI hosts without taking ownership of its notes. The vault remains plain Markdown. Obsidian stays the command center: the notes are still files a person can read and edit when OMS is not running. OMS does not invent the meaning of a property, a folder, or a heading.

## Template and ontology vault model

Meaning stays with the user. Version 4 of `.oms/template-policy.json` is the approved structure and meaning. A property pool records type, format, and intent. An always-on default layer starts empty and applies to every note. An optional individual template may only add or tighten fields, headings, and semantic criteria. It cannot remove or weaken the default. A note with no individual template is an ordinary note under that default. Unmanaged frontmatter is kept and is not checked.

The product hardcodes no property names, folders, or personas, and it has no Inbox fallback. What was retired is `concept` as note identity and bundled runtime defaults, not ontology as the user's account of meaning. `.oms/taxonomy.json` records placement and what folders and links mean. `.obsidian/types.json` is a read-only observation. `.oms/types.json` is a historical version-4 projection: the published version-5 contract neither derives nor reads it, and nothing regenerates it. A historical version-3 or version-4 policy is still read, and a mutating selection migrates it while preserving its recorded meaning.

The agent writes and repairs note files. Before that write, OMS returns the approved Markdown, the effective contract, and a task binding. It then checks the bytes saved on disk. Completion requires a separate host review of those same inputs. A separate instruction-only review is valid. Matching reviewer-file bytes are not proof the host launched that role. A machine pass, a self-issued PASS, or a digest is not that review, and a digest is content integrity rather than authentication. Contract configuration changes only when the user approves the exact diff, by compare-and-swap. Repair is off unless the user enables it. The retry budget is that user's finite nonnegative integer, default 2, including 0, with no separate cap of 3. Search does not wait on that review.

Approved Markdown is the exact UTF-8 snapshot, including any BOM and the original line endings. Editing the managed draft does not replace that snapshot. OMS does not parse or execute Templater, JavaScript, or a private token language.

ADR-014 supersedes ADR-013. [ACKNOWLEDGMENTS](./ACKNOWLEDGMENTS.md) credits Ouroboros and Gajae Code's deep-interview as design ideas. Those credits are not a copied runtime and not a research result. Diagrams in this repository are explanatory sketches. They are not the G002 Excalidraw artifact. These pages record the approved architecture. They are not a host-smoke result and not a product-gate pass.

The authority model is in [architecture](./docs/architecture.md). Vault files are in [conventions](./docs/conventions.md). Leaves are in [the CLI map](./docs/cli-map.md).

## Setup

`oms setup` proposes an empty version-4 policy. It ships no note-type defaults and never modifies notes. Publication goes through the config interview and writes only the user-approved diff. Model lifecycle is `oms model install|select|waive|status`, not a setup-era model flag.

```bash
oms setup --vault /path/to/vault --dry-run
oms setup --vault /path/to/vault --yes --approved-digest <digest>
```

The interview skill agrees each decision with the user, writes the explicit contract document, previews it with `oms template publish`, and publishes only what the user approved. A changed registered source is reviewed with `oms template review-sources` and either acknowledged or relinked; it does not change the contract by itself. OMS keeps no interview state, so there is no question id, census digest, or server-issued approval digest to forward. A general question, an unknown note value, a note error, an unmanaged property, or a search does not start the interview.

The host notice text is exactly `템플릿에 변경이 있습니다` and its actions are exactly `확인하기` and `나중에`. The first notice shows no template name, hash, or change class. `나중에` is host-only and makes no server call. `확인하기` starts the interview skill, which reviews the changed source with `write { op: "template", mode: "review-sources" }` before anything is published.

## CLI

```text
oms bridge add|remove|status                   Manage repository-to-vault target bridges
oms graph build|status                         Build or inspect the note graph
oms hook pre|post                              Run pre- or post-tool-use hooks
oms host install|remove|sync|status            Manage host assets and MCP registrations
oms index sync|embed|repair|status|clean       Manage derived search state
oms link suggest|check                         Suggest or check note wikilinks
oms model install|select|waive|status          Manage local model selection
oms note guide|check|audit|get                Select a contract, check a saved note, audit, or read
oms package check|update                       Check or update the OMS package
oms search query|context                       Run an explicit query or retrieve structured context
oms serve mcp|http                             Start the stdio MCP or local HTTP server
oms setup                                      Propose an empty version-4 policy
oms status                                     Show the read-only aggregate status
oms template list|show|scan|check|publish|review-sources|acknowledge-source|relink-source
```

`oh-my-second-brain` is the full command; `oms` is its short alias. These fourteen families, the eight skills, and the five MCP tools are three different sets. The leaf map is [the CLI map](./docs/cli-map.md).

### Help contract

Every recognized command accepts `--help` and `-h`, exits 0, and performs no side effects. An unknown command combined with `--help` exits 1.

A plain `oms search query <text>` is lexical-only. `--vec` and `--hyde` select their respective channels; `--expand` explicitly enables G004 expansion, `--max-queries` accepts an integer from 1 through 32, and `--rerank` is opt-in. `oms search context` is the separate structured-context surface. Embedding is `oms index embed`; sync and repair are distinct index modes. `oms index status --view status|collections|contexts` preserves all three read-only views, while `oms index clean` removes eligible derived state.

Lexical, vector, HyDE, and typed-axis queries still include unbound, invalid, and incomplete notes. A missing or damaged contract does not stop search. Vector search requires a complete `OMS_EMBEDDING_PROVIDER`/`OMS_EMBEDDING_MODEL` pair. HyDE also requires `OMS_GENERATE_PROVIDER`/`OMS_GENERATE_MODEL`. Reranking requires `OMS_RERANK_PROVIDER`/`OMS_RERANK_MODEL`. Missing, incomplete, or uninstalled selections fail loudly. G004 expansion is an explicit available capability; it makes no replacement, parity, or outperformance claim.

`guide` does not write the note: it selects the contract and returns a session locator. After the agent saves the file, `check` reads that file through the locator and reports declared fields and headings; it issues no completion verdict. Create, append, update, backfill, and complete are not note operations. Link apply is not an operation. Template add, update, move, remove, and default are not operations. There is no version-3 migration, note renderer, or compatibility path for those retired operations.

## MCP tools

`oms serve mcp` exposes exactly five public tools:

`write` · `search` · `link` · `status` · `doctor`

The eight skills (`distill`, `doctor`, `interview`, `link`, `search`, `status`, `template`, `write`) are host workflows. `interview` and `template` are tool-less.

The five tools are a subset of those skills, and neither set is the fourteen CLI families. Detail capabilities remain `op` values under the five tools.

`write` keeps a write posture because interview answers and approved contract publication change managed state. `guide`, `check`, and `complete` write no vault bytes. Contract review uses `op: "template"` with `publish-contract`, `review-sources`, `acknowledge-source`, and `relink-source` only. `status` and every search operation are read-only and do not decide completion. The `doctor` tool diagnoses controls and indexes; it does not backfill notes.

## Install

Node.js 20 or later is required.

```bash
npm install -g oh-my-second-brain
oms host install --runtime all --vault /path/to/vault --yes
```

For Gajae-Code, install the npm package as a marketplace plugin: `gjc plugin install oms@oms`. GJC discovers the eight OMS skills at the package-root `skills/` convention path.

Host installation records the canonical vault in `${XDG_CONFIG_HOME:-~/.config}/oms/vault.json` and stamps `oms serve mcp --vault /path/to/vault` into each managed host entry. `oms host install|remove|sync|status` use that signed pointer only to maintain host integrations. `oms package update` updates the package but never syncs hosts implicitly; run `oms host sync` separately.

Runtime target resolution never reads the host-maintenance pointer. Its precedence is explicit target, local vault controls, bridge, `OMS_VAULT`, then the current directory only as a safe read-only fallback. Control and derived-state mutations cannot use that fallback. Note `guide` and `check` read rather than write ordinary notes; contract publication, confirmed source changes, and derived-state repair still require a verified target.

`OMS_VAULT` is the supported environment fallback when no explicit, local, or bridge target exists.

See [installation](./docs/install.md), [architecture](./docs/architecture.md), [conventions](./docs/conventions.md), [the CLI map](./docs/cli-map.md), [host assets](./docs/adapters.md), and [verified targets](./docs/verified-target.md).
