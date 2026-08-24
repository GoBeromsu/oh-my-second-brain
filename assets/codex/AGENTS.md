# Oh My Second Brain Convention Shim — Codex

<!-- Append this block to your project's AGENTS.md to activate Oh My Second Brain conventions in Codex (oh-my-codex). -->

## Vault Convention (Oh My Second Brain)

This vault is governed by Oh My Second Brain conventions stored in `.oms/`.

**Before working with vault notes:**
- Run `oms doctor` to validate notes against the convention (exits 0, non-blocking).
- Read `.oms/taxonomy.yaml` and `.oms/concepts/*.yaml` for folder and field declarations.

**Write:** Use `$oms-write`. Call MCP `oms_write`. Do not use host Write/Edit for vault `.md` files.
**Retrieve:** Use the `$oms-search` skill with declared lenses.

> **v0 native install:** `oms install --runtime codex` installs Codex rules, the `$oms-write`, `$oms-search`, `$oms-link`, `$oms-distill`, `$oms-status`, and `$oms-doctor` skills, and a managed Codex MCP config. Use Oh My Second Brain MCP tools for vault operations and CLI commands for lifecycle.
