# Oh My Second Brain Convention Shim — Codex

<!-- Append this block to your project's AGENTS.md to activate Oh My Second Brain conventions in Codex (oh-my-codex). -->

## Vault Convention (Oh My Second Brain)

This vault is governed by template-first conventions stored in `.oms/`. People and agents follow the same rules.

### Template authority

- Vault-resident Obsidian `.md` templates are the single source of truth for note shape and body.
- `.obsidian/types.json` is read-only type authority.
- `.oms/template-policy.json` defines template semantics.
- `.oms/types.json` is a derived projection; never hand-edit it.
- Each template has a stable `templateId`. Do not classify templates by persona.

### Operations

- To create or update a vault note, use the `$oms-write` skill and MCP `op:note`. Do not use host Write/Edit for vault notes or managed templates.
- To author or reclassify a template, use MCP `op:template`: first dry-run, then apply with the exact approved `approvedDigest`.
- To search templates, use the `$oms-search` skill and MCP `op:templates`. Search by template, declared field, folder, or link.
- Use `$oms-status` for reads. Use `$oms-doctor` to diagnose and repair.

> **v0 native install:** `oms install --runtime codex` installs Codex rules, the `$oms-write`, `$oms-search`, `$oms-link`, `$oms-distill`, `$oms-status`, and `$oms-doctor` skills, and a managed Codex MCP configuration. Use Oh My Second Brain MCP operations for vault work and CLI commands for lifecycle.
