# Installation

Oh My Second Brain is an npm package with an independent CLI, optional host assets, seven public skills, and five public MCP tools. It requires Node.js 20 or later.

## Install the CLI

```bash
npm install -g oh-my-second-brain
oms --help
```

The package exposes both `oms` and `oh-my-second-brain` command names.

## Install host integrations

Install host surfaces and register the MCP server for a specific vault:

```bash
oms host install --runtime all --vault /path/to/vault --yes
```

Use `claude`, `codex`, or `hermes` instead of `all` to install one runtime. Host integration is optional; CLI lifecycle and vault operations remain available without it.

Installation writes host-native guidance and skill assets, then stamps the host MCP registration as:

```text
oms serve mcp --vault /path/to/vault
```

It also writes a strict signed host-maintenance pointer at
`${XDG_CONFIG_HOME:-~/.config}/oms/vault.json`. Only `host install`, `host
sync`, and `host remove` use this record. Installing or explicitly syncing
another vault uses compare-and-swap and updates every owned host stamp; removal
deletes the pointer last after host cleanup succeeds.

This is an installation detail, not a target-resolution rule. Installing or uninstalling a host does not alter runtime precedence.

### Hermes roots and provenance

Each Hermes command operates on exactly one root. With `OMS_HERMES_HOME` unset,
that root is `~/.hermes` (for example, Sari). To install for a named Hermes
profile such as Xia, run the command separately with that profile directory:

```bash
OMS_HERMES_HOME=~/.hermes/profiles/xia oms host install --runtime hermes --vault /path/to/vault --yes
```

This does not enumerate or modify other profiles; a `hermes -p xia` wrapper
uses the same profile root. Hermes stores npm installation provenance at
`adapters/oms/oms-provenance.json`, outside the skill scan tree. Reinstall
does nothing when the package version and installed skill digest match. A
foreign, incomplete, or tampered install is refused rather than overwritten;
remove or migrate that installation before retrying. A newer recorded npm
version is also refused until an explicit downgrade policy exists; uninstall
remains available for a verified owned installation.

## Target resolution

At runtime, target resolution is ordered as follows:

1. Explicit `--vault`.
2. Local `.oms` template controls.
3. Local bridge.
4. `OMS_VAULT`.
5. Current working directory.

The current-directory fallback is read-only for mutation purposes. See [verified targets](./verified-target.md) for admission behavior. The host's stamped `--vault` simply supplies the first, explicit source; runtime target resolution never reads the maintenance pointer.

## Template setup

Review renderer metadata and observed-contract coverage as well as source paths. Templater sources are contract inputs, never scripts OMS executes; script-first sources without sample notes remain unobserved and unbound. See [renderer boundaries](./conventions.md#setup-and-migration) for refusal diagnostics and proposal limits.

Select one or more template source folders and review the proposal:

```bash
oms setup --vault /path/to/vault \
  --template-folder "Vault Shape/Generated" \
  --template-folder "Team/Curated Shapes" \
  --dry-run
```

Apply only with the exact digest reported by that dry run:

```bash
oms setup --vault /path/to/vault --yes --approved-digest <digest>
```

`--template-folder` is repeatable. Each explicitly selected path is a source
census scope: every `.md` beneath it is a candidate, with no per-file
registration or auto/manual folder mode. This is distinct from the optional
policy `defaultTemplate`, which identifies a note binding.

Obsidian core settings, Templater, and a bounded read-only vault walk provide suggestions only. An unselected non-interactive run stops with `TEMPLATE_FOLDER_SELECTION_REQUIRED` and no approval digest; OMS does not fall back to invented `Templates` or `Inbox` directories. Setup never modifies notes and has no bundled defaults. `.obsidian/types.json` remains read-only; `.oms/template-policy.json` v3 holds semantics and naming; `.oms/taxonomy.json` is the JSON placement authority; `.oms/types.json` is derived and must not be hand-edited. Legacy `taxonomy.yaml` and concept YAML files are neither parsed nor converted and remain untouched.

The dry-run output includes `diagnostics` and `starterTemplates`. An incompatible template is excluded individually with its `TEMPLATE_EXPRESSION_UNSUPPORTED`, `TEMPLATE_SOURCE_INVALID`, or `TEMPLATE_ID_DUPLICATE` path, field when applicable, and remediation; compatible siblings remain in the proposal, while an all-incompatible selection stops with `TEMPLATE_CANDIDATE_INCOMPATIBLE`. Proposed IDs strip `.template` and `.eta` before slugging. Obsidian core `{{date:FMT}}` and `{{time:FMT}}` accept `YYYY YY MM M DD D HH H hh h mm m ss s A a` with `-`, `/`, `.`, `:`, space, or `T` separators; bracket literals are unsupported, and supported tags remain valid in `date` or `datetime` properties.

The census derives metadata (frontmatter keys, types, requiredness, and
`filledBy`) and a bounded body structure of ATX headings, fenced code blocks,
ordered/unordered list runs outside fences, and `<!-- oms:content -->`, plus
document order/EOL/BOM/final-newline details. It does not claim to enforce
paragraphs, setext headings, or all Markdown. The two-tier freshness gate checks
shared authority first, then makes only a changed source's dependent template
pending; unrelated writes remain available, while shared-authority changes fail
closed for the whole vault.

The initial host notice is exactly `템플릿에 변경이 있습니다` with exactly
`확인하기` and `나중에`; it displays no template name, hash, or change class.
`나중에` is host-only and makes no server call or ledger mutation.
`확인하기` starts `write { op: "template", mode: "interview-next" }`.
Answers use `interview-answer` and server-returned next/request/CAS fields.
After all necessary questions, `commit-contracts` publishes only `.oms`
controls after the user approves the exact final digest. Long-lived hosts
surface returned `templateNotice` data even when boot instructions are stale.

Doctor reports each changed template or authority as a separate
`TEMPLATE_SOURCE_DRIFT` item with its path, expected and actual SHA-256
signatures, remediation, and the template ID when available.

Choose model lifecycle explicitly after setup:

- `oms model install`: acquire and verify a model.
- `oms model select`: select an installed model.
- `oms model waive`: explicitly use no model; lexical search remains available.
- `oms model status`: inspect model state without mutation.

These are local verified acquisitions, not runtime downloads. Direct capability
configuration requires complete pairs: vector search uses
`OMS_EMBEDDING_PROVIDER` with `OMS_EMBEDDING_MODEL`; HyDE also uses
`OMS_GENERATE_PROVIDER` with `OMS_GENERATE_MODEL`; reranking uses
`OMS_RERANK_PROVIDER` with `OMS_RERANK_MODEL`. An incomplete or unavailable
pair fails loudly.

## Template commands

Use `oms template list`, `show <id>`, and `scan` for proposals and inspection; `check` verifies current authority and reports runtime observations. Mutations use `--dry-run` followed by the same request with `--yes --approved-digest <digest>`:

```text
oms template add <folder> --dry-run
oms template add --id <id> --from <content.md> --dry-run
oms template update <id> --naming <pattern> --dry-run
oms template move --folder <folder> --dry-run
oms template remove <id> --dry-run
oms template default <id> --dry-run
oms template regenerate-types --dry-run
```

Review uses the exact linear interview leaves:

```text
oms template review
oms template answer <question-id> --answer <JSON> --census-digest <digest> --ledger-digest <digest|null>
oms template commit --census-digest <digest> --ledger-digest <digest|null> --dry-run
oms template commit --census-digest <digest> --ledger-digest <digest|null> --yes --approved-digest <digest>
```

`review` is read-only and starts from the selected-folder census. `answer` is
draft-only and forwards the server-returned question and CAS fields.
`commit` uses the same CAS values plus the existing dry-run or
yes/approved-digest guard. Source review preserves source bytes and publishes
only user-confirmed controls; source authoring, update, move, remove, and
default operations remain separate guarded mutations. Removal keeps the source
unless `--delete-source` is explicitly requested for an OMS-managed source.
`default <id>` chooses the note binding, not a source scope.

Exact note creation usage is:

```text
oms note create [template-id] --body <text>|--body-file <file> [--frontmatter <json>|--frontmatter-file <file>] [--folder <note-folder>]
```

At note creation, placement is explicit caller folder, then taxonomy default,
then `ask`; it is not a contract-review prerequisite and has no Inbox fallback.

## Notes, search, index, and serving

```text
oms note create|append|update|audit|backfill|get
oms search query <text> [--vec <text>] [--hyde <text>] [--expand] [--max-queries <1..32>] [--rerank]
oms search context
oms index sync|embed|repair|status|clean
oms graph build|status
oms serve mcp|http
```

A plain `oms search query <text>` is lexical-only. Every non-lexical channel is
explicit: `--vec`, `--hyde`, G004 `--expand`, and `--rerank`. G004 expansion is
available only when selected; no replacement, parity, or outperformance claim
is made.

`oms index sync`, `oms index embed`, and `oms index repair` are exclusive modes
of the same guarded embedding operation; obsolete boolean `embed` and `force`
combinations are not accepted. `status` is read-only and selects the `status`,
`collections`, or `contexts` view. `clean` removes eligible derived state.

`oms note get` replaces the old document aliases and selects exactly one of a
single target, multiple targets, or a note path plus window. `oms link` checks
and edits wikilinks; `oms bridge add|remove|status` manages the repository-to-
vault bridge and does not invent a repair action.

`oms serve mcp` and `oms serve http` start their respective servers without
creating a vault engine store at startup. There is no OMS host launcher.

## Host, package, and model lifecycle

Use `oms host install|remove|sync|status` for host integrations. `oms package
check|update` manages the npm package only; package update never performs host
sync implicitly. Use `oms model install|select|waive|status` for model lifecycle
instead of setup-era model flags. Hook entrypoints are `oms hook pre|post`;
post-tool-use records the tool result and is not a graph-build alias.

## Skills and MCP tools

The installable skill set is `write`, `search`, `link`, `distill`, `status`, `doctor`, and tool-less `template`. Skills are host workflows, not MCP tool names.

`oms serve mcp` exposes exactly five public tools:

`oms_write` · `oms_search` · `oms_link` · `oms_status` · `oms_doctor`

`oms_status` is read-only. `oms_doctor` diagnoses state and performs supported regenerate/backfill repairs only after verified-target admission. Notes are written through resolved templates in `create`, `append`, or `update` mode.

## Remove host integrations

```bash
oms host remove --runtime all --yes
```

Host removal deletes OMS host registrations and installed host assets. It does not modify vault notes, templates, or vault convention files.

For Hermes, removal deletes only an installation with valid OMS npm
provenance (or the exact legacy seven-skill layout). It refuses to delete a
foreign or tampered skill tree.
