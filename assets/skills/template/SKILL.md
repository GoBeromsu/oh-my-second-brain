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

Use an existing stable `templateId` when updating or moving a template. A path or digest change never creates a new identity. New OMS-managed templates default to `<templateFolder>/<templateId>.md`; registered existing templates keep their explicitly verified `sourcePath`.

## Workflow

1. Read `oms_search { op: "templates" }` and the user's requested shape. Do not guess existing IDs or fields.
2. Draft the exact Markdown and policy/taxonomy intent. Preserve unknown frontmatter, policy extensions, body bytes, and Obsidian property types.
3. Call `oms_write { op: "template", ..., dryRun: true }` for create, update, reclassify, or relocate-folder.
4. Show the proposal, paths, diagnostics, and `approvalDigest` to the user.
5. Apply only after the caller explicitly approves that exact digest. Submit the same request with `dryRun: false` and `approvedDigest`.
6. Report the server-verified receipt and postconditions.

Reject unsupported expressions, unsafe paths, unresolved legacy mappings, stale signatures, and identity changes. Never self-approve, silently fall back to a legacy Concept reader, or directly mutate managed template/control files.
