---
name: template
description: Design, migrate, and safely apply vault-resident Obsidian templates through the derived OMS contract.
---

# template

Turn the user's natural-language note design into an actual Obsidian Markdown template and the smallest matching policy change. People and agents follow the same template contract; never introduce personas.

## Authority

- The actual `.md` template owns frontmatter order/default scaffolding and body shape.
- `.obsidian/types.json` is read-only property-type authority.
- The user-owned ontology remains active: `.oms/template-policy.json` owns note/field `intent` plus BaseContract inheritance, requiredness, formats, allowed values, naming, stable identity, and bindings.
- `.oms/taxonomy.json` owns folder/link `intent`, note placement, and global axes.
- `.oms/types.json` is derived state. Never edit it directly.

Use an existing stable `templateId` when updating or moving a template. A path or digest change never creates a new identity. New OMS-managed templates default to `<sourceFolder>/<templateId>.md` inside a registered template folder (the folder marked `default: true` unless you name another registered folder); registered existing templates keep their explicitly verified `sourcePath`.

## Renderers

Every binding carries `renderer`. Obsidian renders; OMS validates.

- `obsidian-core`: only `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FMT}}`, `{{time:FMT}}` appear. OMS can create notes from it.
- `templater`: `<% %>` appears and the YAML frontmatter parses. OMS extracts the key/type contract; every field whose value is a Templater tag is `filledBy: "obsidian"`. OMS never copies a raw tag into a note and never runs Templater: a note write without caller values for those fields returns `FIELD_FILLED_BY_OBSIDIAN` (ask the user), and a Templater body returns `TEMPLATE_RENDERER_EXTERNAL`.
- `none`: script-first or no frontmatter. The contract comes from notes Obsidian already produced (`contract-from-notes`), with the sample count and field coverage shown in the proposal; zero samples is `TEMPLATE_CONTRACT_UNOBSERVED`, not unused.

You may **propose** an `obsidian-core` copy of a Templater template when the mapping is exact: `tp.date.now("FMT")` -> `{{date:FMT}}` / `{{time:FMT}}`, `tp.file.title` -> `{{title}}`. Anything else has no faithful mapping; do not invent one. Submit the converted bytes as a new template through the guarded flow; the kernel validates syntax, contract, path, signatures, and CAS, and the user approves the digest.

## Workflow

1. Read `search { op: "templates" }` to list bindings, or `search { op: "templates", templateId }` to show one, then read the user's requested shape. Use `search { op: "template-scan" }` for candidates. Do not guess existing IDs or fields, and never auto-register a scan result.
2. Draft the exact Markdown and policy/taxonomy intent. Preserve unknown frontmatter, policy extensions, body bytes, and Obsidian property types.
3. Call `write { op: "template", ..., dryRun: true }` for create, update, reclassify, relocate-folder, register-folder, remove, or default. Regeneration is not a write-template mode: use `doctor { op: "regenerate-types", dryRun: true }`. Current signatures are derived and verified by the server, not hand-assembled by the host.
4. To adopt a template that already exists in the vault, call `write { op: "template", mode: "register-existing", templateId, sourceFolder, sourcePath, renderer, filledBy, contract, naming, dryRun: true }` instead. `filledBy` lists Obsidian-filled field names (an empty array for a Core template). The server verifies the proposed metadata against the source and derives every signature itself; you supply no `expected*` digests and no template bytes.
5. Show the proposal, paths, diagnostics, and `approvalDigest` to the user.
6. Apply only after the caller explicitly approves that exact digest. Submit the same request with `dryRun: false` and `approvedDigest`.
7. Report the server-verified receipt and postconditions.

CLI uses the noun leaves `oms template scan|list|show|add|update|move|remove|default|check|regenerate-types`. Mutations require `--dry-run`, then the same request with `--yes --approved-digest`; resume uses `oms template update --resume` with the exact `transactionId` and `approvedDigest`. `add <folder>` registers a source folder; `add <file> --id` registers existing bytes; `add --id --from` proposes a new source inside an explicitly registered creation folder. `default <id>` chooses the default note binding, not the source creation folder. Removal keeps registered-existing files; `--delete-source` applies only to managed sources. Never remove the current default without selecting another binding first.

Reject unsupported expressions, unsafe paths, unresolved legacy mappings, stale signatures, and identity changes. Preserve non-observed proposal gaps explicitly. Never self-approve, silently fall back to a legacy Concept reader, or directly mutate managed template/control files.
