# Oh My Second Brain Convention Shim — Hermes

<!-- Add this as a context file in your Hermes session to activate Oh My Second Brain conventions. -->

## Vault Convention (Oh My Second Brain)

This vault is governed by Oh My Second Brain conventions stored in `.oms/`.

**Before working with vault notes:**
- Run `oms doctor` to validate notes against the convention (exits 0, non-blocking).
- Read `.oms/taxonomy.yaml` for folder-to-concept bindings.
- Read `.oms/concepts/*.yaml` for field declarations and lenses.

**Write:** Use the `write` skill. Call MCP `oms_write`. Do not use host Write/Edit for vault `.md` files.

**Retrieve:** Use the `search` skill or follow the retriever persona — identify purpose, match lens, project lens fields only.

> **v0 native install:** `oms install --runtime hermes` installs the `write`, `search`, `link`, `distill`, `status`, and `doctor` skills and registers Oh My Second Brain MCP in `~/.hermes/config.yaml`. Use Oh My Second Brain MCP tools for vault operations and CLI commands for lifecycle.
