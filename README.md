# Oh My Second Brain

Oh My Second Brain (`oms`) connects an existing Obsidian or Markdown vault to AI hosts without taking ownership of its notes. The vault remains plain Markdown.

## Template and ontology vault model

- Actual vault-resident Obsidian `.md` templates own managed frontmatter shape and body scaffolding.
- Each template has a stable `templateId`, independent of its path and digest, and inherits one vault-wide `BaseContract`.
- `.obsidian/types.json` is read-only type authority.
- The user-owned ontology remains active: `.oms/template-policy.json` records note/field meaning alongside requiredness, formats, allowed values, defaults, naming, identity, and bindings.
- `.oms/taxonomy.json` records folder/link meaning and owns placement; authored folder intents are exposed through the `folder-ontology` search axis. It is the sole runtime authority.
- `.oms/types.json` is a validated derived write/search projection. Never hand-edit it.

The retired model is `concept` as note identity and bundled runtime defaults—not ontology as semantic meaning.

## Setup

Setup recursively discovers existing templates within explicitly selected
template folders and proposes migration. It ships no note-type defaults and
never modifies notes.

```bash
oms setup --vault /path/to/vault --dry-run
oms setup --vault /path/to/vault --yes --approved-digest <shown-digest>
```

Managed-template changes use the same dry-run, exact caller approval, compare-and-swap, transaction, and postcondition receipt boundary.

## Template workflow

An explicitly selected template folder makes every `.md` beneath it a template
source candidate. Review verifies the source and preserves its bytes in place;
no per-file registration or auto/manual folder mode is required. OMS derives
both metadata (frontmatter keys, types, requiredness, and `filledBy`) and a
bounded body structure (ATX headings, fenced code blocks, ordered/unordered
list runs outside fences, `<!-- oms:content -->`, and document
order/EOL/BOM/final-newline details). It does not claim to enforce paragraphs,
setext headings, or all Markdown. A changed source makes only its dependent
template pending, so unrelated writes remain available; shared-authority
changes or mismatches fail closed for the whole vault.

When a selected-folder source changes, the initial host notice is exactly
`템플릿에 변경이 있습니다` with exactly `확인하기` and `나중에`; it names no
template and shows no hash or change class. `나중에` is host-only and makes no
server call or ledger mutation. `확인하기` starts a linear, resumable interview
through MCP `write { op: "template", mode: "interview-next" }`. Continue with
the server-returned next question, preserving unaffected confirmed answers.
After all necessary questions, show the exact final digest and publish only
`.oms` controls after the user approves it with `mode: "commit-contracts"`; never
self-approve. `status` and search remain read-only, and long-lived hosts
surface a returned `templateNotice` even when boot instructions are stale.

The exact CLI review flow is:

```text
oms template review
oms template answer <question-id> --answer <JSON> --census-digest <digest> --ledger-digest <digest|null>
oms template commit --census-digest <digest> --ledger-digest <digest|null> --dry-run
oms template commit --census-digest <digest> --ledger-digest <digest|null> --yes --approved-digest <digest>
```

Answer uses the server-returned question and CAS values. Commit uses the same
CAS values plus the existing dry-run or yes/approved-digest guard.

The exact note-create usage is:

```text
oms note create [template-id] --body <text>|--body-file <file> [--frontmatter <json>|--frontmatter-file <file>] [--folder <note-folder>]
```

At note creation, placement is explicit caller folder, then the taxonomy
default, then `ask`; missing placement does not block contract review.

## CLI

```text
oms setup                                      Discover and adopt existing vault templates
oms template scan|list|show|add|update|move|remove|default|check|regenerate-types|review|answer|commit
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

Template contract review uses `oms_write` with `op: "template"` and exactly
`interview-next`, `interview-answer`, and `commit-contracts` modes. The exact
CLI counterparts are `oms template review`, `oms template answer`, and
`oms template commit`. Answer submissions use the server-returned question,
request, and CAS fields; hosts must not invent parameter names. A zero-question
response proceeds directly to final confirmation.

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
