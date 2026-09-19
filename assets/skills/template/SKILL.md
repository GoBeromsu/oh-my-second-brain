---
name: template
description: Design, migrate, and safely apply vault-resident Obsidian templates through the derived OMS contract.
---

# template

Turn the user's natural-language note design into an actual Obsidian Markdown template and the smallest matching policy change. People and agents follow the same template contract; never introduce personas.

## Authority and source scope

- The actual `.md` template owns frontmatter order/default scaffolding and body shape.
- `.obsidian/types.json` is read-only property-type authority.
- The user-owned ontology remains active: `.oms/template-policy.json` owns note/field `intent` plus BaseContract inheritance, requiredness, formats, allowed values, naming, stable identity, and bindings.
- `.oms/taxonomy.json` owns folder/link `intent`, note placement, and global axes.
- `.oms/types.json` is derived state. Never edit it directly.
- Every `.md` beneath an explicitly selected template folder is a template candidate. The source bytes stay at their existing vault-relative path; contract review reads and verifies them but does not rewrite them.
- Selecting a folder is the only scope-widening act. A candidate does not need a per-file registration step or a folder mode.

Use an existing stable `templateId` when updating or moving a template. A path or digest change never creates a new identity; the server derives an ID for a newly discovered source. For note creation, choose a destination in this order: an explicit caller folder, the taxonomy default for that template, then `ask`. Placement is not a contract-review prerequisite and there is no implicit Inbox fallback.

## Derived contracts

OMS derives both parts of the contract from the selected source:

- The metadata contract records frontmatter keys, types, requiredness, and `filledBy`. Unknown frontmatter and policy extensions remain preserved.
- The body-format contract records supported nodes: ATX headings, fenced code blocks, contiguous ordered or unordered list runs outside fences, and the `<!-- oms:content -->` placeholder. It also records document order, EOL, BOM, and final-newline details. This bounded scanner does not claim to enforce paragraphs, setext headings, or all Markdown; an ambiguous source fact becomes an interview question rather than an inferred rule.

## Renderers

Every binding carries `renderer`. Obsidian renders; OMS validates.

- `obsidian-core`: only `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FMT}}`, `{{time:FMT}}` appear. OMS can create notes from it.
- `templater`: `<% %>` appears and the YAML frontmatter parses. OMS extracts the key/type contract; every field whose value is a Templater tag is `filledBy: "obsidian"`. OMS never copies a raw tag into a note and never runs Templater: a note write without caller values for those fields returns `FIELD_FILLED_BY_OBSIDIAN` (ask the user), and a Templater body returns `TEMPLATE_RENDERER_EXTERNAL`.
- `none`: script-first or no frontmatter. The contract comes from notes Obsidian already produced (`contract-from-notes`), with the sample count and field coverage shown in the proposal; zero samples is `TEMPLATE_CONTRACT_UNOBSERVED`, not unused.

You may **propose** an `obsidian-core` copy of a Templater template when the mapping is exact: `tp.date.now("FMT")` -> `{{date:FMT}}` / `{{time:FMT}}`, `tp.file.title` -> `{{title}}`. Anything else has no faithful mapping; do not invent one. Submit the converted bytes as a new template through the guarded flow; the kernel validates syntax, contract, path, signatures, and CAS, and the user approves the digest.

## Source-change notice and interview

A selected-folder source census detects pending adds, edits, deletes, and renames. The first displayed notice is exactly:

```text
템플릿에 변경이 있습니다
```

It has exactly `확인하기` and `나중에` actions. Do not render a template name, hash, or change taxonomy in that initial notice. A machine `templateNotice` may carry richer state for the host, but the host must keep the first display generic.

- `나중에` is host-only: dismiss or defer locally. Do not call the server or mutate the interview ledger.
- `확인하기` starts the one linear interview with `write { op: "template", mode: "interview-next" }`.
- Submit each answer with `mode: "interview-answer"` using the question, request, and CAS values returned by the server. Do not invent parameter names, questions, or digests.
- Resume from the next question returned by each answer. Opening a new review reopens deferred deletion decisions without editing the draft or erasing other confirmed answers. This is distinct from host-only `나중에`; a zero-question response still requires final confirmation.
- After every required question is answered, show the server's final proposal and exact final approval digest. Call `mode: "commit-contracts"` only after the user approves that exact digest; never self-approve.

Long-lived hosts must surface `templateNotice` on `write`, `search`, and `status` results even when boot instructions are stale. Emit it once per process and pending digest (and again when that digest changes); `status` remains the polling view and writes nothing.

## Workflow

1. Read `search { op: "templates" }` to list bindings, or `search { op: "templates", templateId }` to show one. Use `search { op: "template-scan" }` for the read-only census and pending view; never treat that view as a write.
2. Draft the exact Markdown and policy/taxonomy intent. Preserve unknown frontmatter, policy extensions, body bytes, and Obsidian property types.
3. Use guarded template operations with a dry run for source authoring and for separate update, move, remove, reclassify, relocate, folder-scope, or default changes. Explicit source authoring is `oms template add --id <id> --from <source>`; it is not contract review. Contract review never writes source bytes. Current signatures are derived and verified by the server, not hand-assembled by the host.
4. Show the proposal, paths, diagnostics, and `approvalDigest` to the user. Apply a guarded operation only after the caller explicitly approves that exact digest, then report the server-verified receipt and postconditions.

CLI uses the noun leaves `oms template scan|list|show|add|update|move|remove|default|check|regenerate-types|review|answer|commit`.

- `oms template add <folder>` adds an explicit source scope; `oms template add --id <id> --from <source>` authorizes new source authoring.
- `oms template review`, `answer`, and `commit` are the exact CLI counterparts of MCP `interview-next`, `interview-answer`, and `commit-contracts`.
- `scan` is read-only. Update, move, remove, and other template mutations remain separate guarded operations; none is a substitute for contract review.

Reject unsupported expressions, unsafe paths, stale signatures, and identity changes. Preserve non-observed proposal gaps explicitly. Never self-approve, use a stale-contract fallback or compatibility reader, or directly mutate managed template/control files.
