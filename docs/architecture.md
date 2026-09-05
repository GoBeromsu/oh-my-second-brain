# Architecture

Oh My Second Brain is a template-first vault integration. It keeps the vault as plain Markdown and separates user-owned authorities from generated runtime data.

## Authorities and derived state

```text
vault Markdown templates ──> frontmatter/body shape ──> ResolvedTemplate writes
         │                              │
         │                              └── BaseContract inheritance
         │
.obsidian/types.json ───────────────> read-only type authority
.oms/template-policy.json ──────────> note/field ontology, naming, defaults
.oms/taxonomy.json ─────────────────> folder/link ontology and placement
         │
         └───────────────────────────> .oms/types.json (validated derived projection)
```

Vault-resident Obsidian Markdown templates own a managed note's shape and body. Each managed template has a stable `templateId`; moving or editing the file does not make identity path- or digest-derived. The BaseContract is inherited by every managed TemplateContract.

`.obsidian/types.json` is read-only. The user-owned ontology is the semantic metadata separated from template shape: `.oms/template-policy.json` records note and field `intent` alongside naming/default policy, while `.oms/taxonomy.json` records folder/link `intent` and placement. `.oms/types.json` is generated after validation and is used as a write/search projection; it is never authority or hand-edited configuration.

Policy version 3 registers template source folders as `templateFolders`, each with `auto` or `manual` mode. Bindings carry both their registered `sourceFolder` and exact `sourcePath`. A folder-level `default` chooses where a new template is created; the independent optional `defaultTemplate` chooses a note binding.

Taxonomy controls placement without deciding a template's keys. Its `templateFolder` is a note destination and need not be within a registered template source folder. Placement is required; there is no `Inbox` fallback. Folder and wikilink relationships are global axes, so retrieval is not constrained to a single placement rule. Authored folder intents are exposed through the derived `folder-ontology` axis. `.oms/taxonomy.json` is the sole taxonomy authority; setup does not parse or convert legacy `taxonomy.yaml` or concept YAML. Removing the legacy `concept` note identity and bundled ontology runtime defaults does not remove ontology: meaning remains active, vault-owned data.

## Lifecycle

Renderer classification separates executable Obsidian templates from OMS note scaffolds. Templater frontmatter supplies a contract with Obsidian-filled fields; script-first sources derive proposals from observed notes. The kernel validates bounded host proposals and transaction evidence, never executes scripts or provides a Templater transpiler.

Setup selects folders only from repeated explicit `--template-folder` arguments or saved valid-v3 registrations. Explicit folders use `auto` proposal mode and the first is the template-creation default; saved modes are retained. Obsidian, Templater, and bounded vault-walk evidence is suggestion-only and carries provenance, never automatic selection. Without a selection, non-interactive setup is blocked and produces no approval digest. There are no invented `Templates` or `Inbox` defaults.

Setup recursively discovers templates within selected folders, produces a migration proposal, and leaves notes unchanged. Unsupported policy versions fail closed at runtime. Setup exposes replaced legacy fields as `droppedKeys`, preserves writers and unknown extensions in its proposed v3 policy, and includes the old policy bytes in compare-and-swap approval. A resolved dry run exposes proposed state; applying requires the exact `--approved-digest` returned by that dry run.

Template mutations follow the same boundary: dry run, explicit digest approval, compare-and-swap, and a transaction receipt. This prevents applying a review to different template contents.

For note operations, the runtime resolves a `ResolvedTemplate` before writing. `create`, `append`, and `update` have separate existence preconditions. Admission completes before disk mutation. A successful mutation returns a receipt with target and operation information.

## Retrieval and operations

Search is lexical and works without `.oms/types.json`. It supports narrowing by managed template, declared field, folder, and wikilink; managed sources are excluded from normal note results. Vector search is never faked: unavailable vector capability remains unavailable.

`doctor` diagnoses vault state and can regenerate projections or backfill supported data. Repair is subject to verified-target admission. `status` only reports state and never mutates it.

## Public surfaces

The CLI works independently of host integrations. Installable assets are under [`assets/`](../assets/): seven public skills (`write`, `search`, `link`, `distill`, `status`, `doctor`, and tool-less `template`) and host guidance. `assets/claude/`, `assets/codex/`, and `assets/hermes/` contain host-specific files.

MCP is a separate API surface. `oms mcp` serves exactly five public capabilities: write, search, link, status, and doctor. Skills are host-facing workflows; MCP tools are callable operations. Neither replaces the independent CLI.

### MCP namespace boundary

The MCP server id is `oms`, while its local tool names are capability-only:
`write`, `search`, `link`, `status`, and `doctor`. Qualifying supported hosts
therefore display `oms_write`, `oms_search`, `oms_link`, `oms_status`, and
`oms_doctor` exactly once; no supported host may render `oms_oms_*`. Raw MCP
clients call the local names, so callers using the former `oms_write`,
`oms_search`, `oms_link`, `oms_status`, or `oms_doctor` names must migrate to
`write`, `search`, `link`, `status`, or `doctor`.

See [conventions](./conventions.md) for vault data and [verified targets](./verified-target.md) for target resolution and mutation admission.
