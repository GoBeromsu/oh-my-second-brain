# Oh My Second Brain

Oh My Second Brain (`oms`) connects an existing Obsidian or Markdown vault to AI hosts without taking ownership of its notes. The vault remains plain Markdown. Obsidian stays the command center: the notes are still files a person can read and edit when OMS is not running. OMS does not invent the meaning of a property, a folder, or a heading.

## Template and ontology vault model

Meaning stays with the user. Version 5 of `.oms/template-policy.json` is the published structure and meaning. A property pool records type, format, and intent. An always-on common contract has no Markdown file of its own and applies to every note and every registered template. OMS declares no common field itself, so it holds exactly what the published document says. An explicitly registered template inherits that contract and may add to it, tighten it, or relax it where the user approved that relaxation. A note with no registered template is an ordinary note under the common contract. Unmanaged frontmatter is kept and is not checked. A value set is closed only when its document declares `valuePolicy: "closed"`; an `allowedValues` list alone is a suggestion.

The product hardcodes no property names, folders, or personas, and it has no Inbox fallback. What was retired is `concept` as note identity and bundled runtime defaults, not ontology as the user's account of meaning. `.oms/taxonomy.json` records placement and what folders and links mean. `.obsidian/types.json` is a read-only observation. `.oms/types.json` is a historical version-4 projection: the published version-5 contract neither derives nor reads it, and nothing regenerates it. A historical version-3 or version-4 policy remains readable; only a mutating selection migrates it in place while preserving its recorded meaning. A held or unproved historical contract is reported as `review-required`, not rewritten.

The agent writes and repairs note files. Before that write, `guide` selects the contract for one explicit note path and returns a session locator. It then checks the bytes saved on disk through that locator, reporting declared properties and headings with `semantic: "not-evaluated"`. OMS has no completion call and no separate reviewer conversation. Contract configuration changes only when the user approves the exact diff, by compare-and-swap. Repair is off unless the user turns it on in `.oms/settings.json`, which is portable vault settings rather than the contract. OMS declares no retry budget and counts no attempts. Search does not wait on that…

Each registered source remains the user's own Markdown file, recorded by its path and content hash. OMS never rewrites, copies, or snapshots that source, has no managed drafts or `.oms/templates/` directory, and stores no approved-Markdown bytes in the policy. OMS does not parse or execute Templater, JavaScript, or a private token language.

ADR-015 supersedes ADR-014, which superseded ADR-013. [ACKNOWLEDGMENTS](./ACKNOWLEDGMENTS.md) credits Ouroboros and Gajae Code's deep-interview as design ideas. Those credits are not a copied runtime and not a research result. Diagrams in this repository are explanatory sketches. They are not the G002 Excalidraw artifact. These pages record the approved architecture. They are not a host-smoke result and not a product-gate pass.

The authority model is in [architecture](./docs/architecture.md). Vault files are in [conventions](./docs/conventions.md). Leaves are in [the CLI map](./docs/cli-map.md).

## Setup

`oms setup` connects the vault: it writes the portable `.oms/settings.json` identity and the host connection after you approve the digest its dry-run printed, and it can select a model in the same pass. It publishes no contract and never modifies notes. The contract is published by `oms template publish` after the interview agrees it. Model lifecycle also stands alone as `oms model install|select|waive|status`.

```bash
oms setup --vault /path/to/vault --dry-run
oms setup --vault /path/to/vault --yes --approval-token <token> --approved-digest <digest>
```

The interview skill agrees each decision with the user, writes the explicit contract document, previews it with `oms template publish`, and publishes only what the user approved. A changed registered source is drift evidence: `oms template review-sources` reviews it, `oms template acknowledge-source` advances only the recorded hash using the live reviewed digest, and `oms template relink-source` requires a genuinely missing original and the exact candidate path the user supplies. It does not change the contract by itself. OMS keeps no interview state, so there is no question id, census digest, or server-issued approval digest to forward. A general question, an unknown note value, a note error, an unmanaged property, or a search does not start the interview.

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
oms setup                                      Connect the vault and write its portable identity
oms status                                     Show the read-only aggregate status
oms template list|show|scan|check|publish|review-sources|acknowledge-source|relink-source
```

`oh-my-second-brain` is the full command; `oms` is its short alias. These fourteen families, the eight skills, and the five MCP tools are three different sets. The leaf map is [the CLI map](./docs/cli-map.md).

### Help contract

Every recognized command accepts `--help` and `-h`, exits 0, and performs no side effects. An unknown command combined with `--help` exits 1.

A plain `oms search query <text>` is lexical-only. `--vec` and `--hyde` select their respective channels; `--expand` explicitly enables G004 expansion, `--max-queries` accepts an integer from 1 through 32, and `--rerank` is opt-in. `oms search context` is the separate structured-context surface. Embedding is `oms index embed`; sync and repair are distinct index modes. `oms index status --view status|collections|contexts` preserves all three read-only views, while `oms index clean` removes eligible derived state.

Lexical, vector, HyDE, and typed-axis queries still include unbound, invalid, and incomplete notes. A missing or damaged contract does not stop search. Vector search requires a complete `OMS_EMBEDDING_PROVIDER`/`OMS_EMBEDDING_MODEL` pair. HyDE also requires `OMS_GENERATE_PROVIDER`/`OMS_GENERATE_MODEL`. Reranking requires `OMS_RERANK_PROVIDER`/`OMS_RERANK_MODEL`. Missing, incomplete, or uninstalled selections fail loudly. G004 expansion is an explicit available capability; it makes no replacement, parity, or outperformance claim.

`guide` does not write the note: it selects the contract and returns a session locator. After the agent saves the file, `check` reads that file through the locator and reports declared fields and headings with `semantic: "not-evaluated"`; it issues no completion verdict. Create, append, update, and backfill are retired note operations. Link apply is not an operation. Template add, update, move, remove, and default are not operations. There is no note renderer or compatibility path for those retired operations.

## MCP tools

`oms serve mcp` exposes exactly five public tools:

`write` · `search` · `link` · `status` · `doctor`

The eight skills (`distill`, `doctor`, `interview`, `link`, `search`, `status`, `template`, `write`) are host workflows. `interview` and `template` are tool-less.

The five tools are a subset of those skills, and neither set is the fourteen CLI families. Detail capabilities remain `op` values under the five tools.

`write` keeps a write posture because explicit contract publication and confirmed source changes mutate managed state. `guide` and `check` write no vault bytes. Contract review uses `op: "template"` with `publish-contract`, `review-sources`, `acknowledge-source`, and `relink-source` only. `status` and every search operation are read-only and do not decide completion. The `doctor` tool diagnoses controls and indexes; it does not backfill notes.

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
