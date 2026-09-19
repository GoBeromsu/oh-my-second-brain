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

Policy version 3 stores explicitly selected template folders as source scopes.
Every `.md` beneath a selected folder is a census candidate; no per-file
registration or auto/manual folder mode is required. Bindings carry their
`sourceFolder` and exact `sourcePath`. The independent optional
`defaultTemplate` chooses a note binding.

Approved review and source-authoring transactions record
`approvedSourceSignature` and `approvedBodySignature` in the user-owned binding.
These record actual source and raw-body evidence, not inferred body requirements.
Automatic identical-byte
renames require this independent evidence; a derived projection's self-reported
digest cannot authorize identity transfer. Approved body signatures can suggest
renames after restart even without a body contract, but those suggestions still
require confirmation. Mutation IDs and taxonomy references use the same NFC
identity before routing; canonical definition collisions are invalid authority.

Taxonomy controls placement without deciding a template's keys. Its
`templateFolder` is a note destination and need not be within a template source
folder. Placement is optional during contract review; at note creation the
precedence is explicit caller folder, then taxonomy default, then `ask`, with no
invented Inbox fallback. Folder and wikilink relationships are global axes, so
retrieval is not constrained to a single placement rule. Authored folder intents
are exposed through the derived `folder-ontology` axis. `.oms/taxonomy.json` is
the sole taxonomy authority; setup does not parse or convert legacy
`taxonomy.yaml` or concept YAML. Removing the legacy `concept` note identity and
bundled ontology runtime defaults does not remove ontology: meaning remains
active, vault-owned data.

## Lifecycle

Runtime observations use an external SQLite journal at `~/.oms/runtime/v1/<hostId>/events.sqlite` (`OMS_RUNTIME_ROOT` overrides the base directory). Containment is checked before creation, and WAL/SHM files stay outside the vault. Each actual event has a UUID; only replay of that same event ID is deduplicated. Invocation and attempt indexes are nonunique. History queries are readonly/no-create and filter by current host and canonical vault fingerprint. Journal bytes are never convention authority or approval-digest input.

Read-only engine consumers share a stable, temporary snapshot of the existing database and committed WAL outside the source vault. They never open a SQLite connection to the original, so even transient source WAL/SHM creation is forbidden. The snapshot is removed when the reader closes; it is not another authoritative store. Missing indexes use the existing ephemeral core path, while corrupt or unstable existing input fails visibly.

MCP and HTTP SQLite engines are request-scoped so later requests see external index replacements. Within each MCP server, index sync, embedding, cleanup, and repair share a FIFO mutation queue held until the request's engines close. Read-only requests do not wait on this queue. A failed engine close returns `ENGINE_LIFECYCLE_FAILED` and prevents subsequent index mutations until the server restarts.

Renderer classification separates executable Obsidian templates from OMS note scaffolds. Templater frontmatter supplies a contract with Obsidian-filled fields; script-first sources derive proposals from observed notes. The kernel validates bounded host proposals and transaction evidence, never executes scripts or provides a Templater transpiler.

Setup selects folders through repeated explicit `--template-folder` arguments.
Each selected folder is a census scope for every `.md` beneath it; there is no
per-file registration or folder mode. Obsidian, Templater, and bounded
vault-walk evidence is suggestion-only and carries provenance, never automatic
selection. Without a selection, non-interactive setup is blocked and produces
no approval digest. There are no invented `Templates` or `Inbox` defaults.

Setup recursively discovers templates within selected folders, produces a
migration proposal, and leaves notes unchanged. Unsupported policy versions
fail closed at runtime. Setup exposes replaced legacy fields as `droppedKeys`,
preserves writers and unknown extensions in its proposed v3 policy, and includes
the old policy bytes in compare-and-swap approval. A resolved dry run exposes
proposed state; applying requires the exact `--approved-digest` returned by that
dry run.

Template mutations follow the same boundary: dry run, explicit digest approval, compare-and-swap, and a transaction receipt. This prevents applying a review to different template contents.

The source census derives both a metadata contract (frontmatter keys, types,
requiredness, and `filledBy`) and a bounded body contract for ATX headings,
fenced code blocks, ordered or unordered list runs outside fences, and the
`<!-- oms:content -->` placeholder, with document order/EOL/BOM/final-newline
details. It does not claim to enforce paragraphs, setext headings, or all
Markdown. The two-tier freshness gate checks shared authority first, then
makes only a changed source's dependent template pending; unrelated templates
remain usable. Shared-authority changes fail closed vault-wide.

Contract review is a linear, resumable interview. The initial notice is exactly
`템플릿에 변경이 있습니다` with exactly `확인하기` and `나중에`; it displays no
template name, hash, or change class. `나중에` is host-only and does not call
the server or mutate the interview ledger. `확인하기` enters
`write { op: "template", mode: "interview-next" }`; answers use
`interview-answer` and the server-returned next/request/CAS fields. After all
necessary questions, only the exact user-approved final digest may invoke
`commit-contracts`, which publishes controls only. The CLI counterparts are
`oms template review`, `oms template answer`, and `oms template commit`.
Long-lived hosts surface `templateNotice` on tool results even when boot
instructions are stale. Pending body contracts and incomplete fresh projection
coverage also trigger the notice, even when the raw census has no new diff.
Approval rechecks the complete selected census as well as captured control and
known-source bytes, so a newly appearing unbound source invalidates the review.

For note operations, the runtime resolves a `ResolvedTemplate` before writing.
`create`, `append`, and `update` have separate existence preconditions. At
create, an explicit caller folder takes precedence over a taxonomy default,
then `ask`; placement is not a contract-review prerequisite. Admission
completes before disk mutation. A successful mutation returns a receipt with
target and operation information.

## Retrieval and operations

Search is lexical and works without `.oms/types.json`. It supports narrowing by managed template, declared field, folder, and wikilink; managed sources are excluded from normal note results. Vector search is never faked: unavailable vector capability remains unavailable.

`doctor` diagnoses vault state and can regenerate projections or backfill supported data. Repair is subject to verified-target admission. `status` only reports state and never mutates it.

## Public surfaces

The CLI works independently of host integrations. Installable assets are under [`assets/`](../assets/): seven public skills (`write`, `search`, `link`, `distill`, `status`, `doctor`, and tool-less `template`) and host guidance. `assets/claude/`, `assets/codex/`, and `assets/hermes/` contain host-specific files.

MCP is a separate API surface. `oms serve mcp` serves exactly five public capabilities: write, search, link, status, and doctor. Skills are host-facing workflows; MCP tools are callable operations. Neither replaces the independent CLI.

The [command map](./cli-map.md) assigns each capability one CLI leaf and, where exposed, one exclusive MCP operation or mode. `bridge` owns repository-to-vault links; `link` owns note wikilinks. `package update` installs OMS, while `host sync` refreshes host registrations separately. `serve mcp` and `serve http` must not create a vault engine store on startup. Retired top-level commands are not aliases.

### MCP namespace boundary

The MCP server id is `oms`, while its local tool names are capability-only:
`write`, `search`, `link`, `status`, and `doctor`. Qualifying supported hosts
therefore display `oms_write`, `oms_search`, `oms_link`, `oms_status`, and
`oms_doctor` exactly once; no supported host may render `oms_oms_*`. Raw MCP
clients call the local names, so callers using the former `oms_write`,
`oms_search`, `oms_link`, `oms_status`, or `oms_doctor` names must migrate to
`write`, `search`, `link`, `status`, or `doctor`.

See [conventions](./conventions.md) for vault data and [verified targets](./verified-target.md) for target resolution and mutation admission.
