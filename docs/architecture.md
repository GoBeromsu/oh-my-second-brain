# Architecture

Oh My Second Brain is a template-first vault integration. It keeps the vault as plain Markdown and separates user-owned authorities from generated runtime data.

## Authorities and derived state

```text
vault Markdown templates ──> managed TemplateContracts ──> ResolvedTemplate writes
         │                              │
         │                              └── BaseContract inheritance
         │
.obsidian/types.json ───────────────> read-only type authority
.oms/template-policy.json ──────────> semantics, naming, defaults
         │
         └───────────────────────────> .oms/types.json (validated derived projection)
```

Vault-resident Obsidian Markdown templates own a managed note's shape and body. Each managed template receives a stable `templateId`; moving or editing the file does not make its identity path- or digest-derived. The BaseContract is inherited by every managed TemplateContract.

`.obsidian/types.json` is read-only. `.oms/template-policy.json` records OMS semantics, naming, and defaults. `.oms/types.json` is generated only after validation and is used as a write/search projection; it is never an authority or a hand-edited configuration file.

Taxonomy controls placement. Folder and wikilink relationships are global axes, so retrieval is not constrained to a single placement rule.

## Lifecycle

Setup recursively discovers existing templates, produces a migration proposal, and leaves notes unchanged. It has no bundled default template authority. A dry run exposes the proposed state; applying requires the exact `--approved-digest` returned by that dry run.

Template mutations follow the same boundary: dry run, explicit digest approval, compare-and-swap, and a transaction receipt. This prevents applying a review to different template contents.

For note operations, the runtime resolves a `ResolvedTemplate` before writing. `create`, `append`, and `update` are separate modes with their own existence preconditions. Admission completes before disk mutation. A successful mutation is represented by a receipt, including the resolved target and applied operation.

## Retrieval and operations

Search is lexical and works without `.oms/types.json`. It supports narrowing by managed template, declared field, folder, and wikilink; managed sources are excluded from normal note results. Vector search is never faked: unavailable vector capability remains unavailable.

`doctor` diagnoses vault state and can regenerate projections or backfill when an operation supports it. Repair is subject to verified-target admission. `status` only reports state and never mutates it.

## Public surfaces

The CLI works independently of host integrations. Installable assets are under [`assets/`](../assets/): six public skills (`write`, `search`, `link`, `distill`, `status`, `doctor`) and host guidance. `assets/claude/`, `assets/codex/`, and `assets/hermes/` contain the host-specific files.

MCP is a separate API surface. `oms mcp` serves exactly five public tools: `oms_write`, `oms_search`, `oms_link`, `oms_status`, and `oms_doctor`. Skills are host-facing workflows; MCP tools are callable operations. Neither replaces the independent CLI.

See [conventions](./conventions.md) for vault data and [verified targets](./verified-target.md) for target resolution and mutation admission.
