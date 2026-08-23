# Oh My Second Brain Convention Fragment

<!-- Append this block to your project's CLAUDE.md to activate Oh My Second Brain conventions in Claude Code. -->

## Vault Convention (Oh My Second Brain)

This vault is governed by Oh My Second Brain conventions stored in `.oms/`.
All knowledge capture and retrieval must follow the declared semantic convention.

**Before working with vault notes:**
- Run `oms doctor` to validate existing notes against the convention (exits 0, non-blocking).
- Read `.oms/taxonomy.yaml` to understand which folders hold which concepts.
- Read `.oms/concepts/*.yaml` to understand field requirements and lenses.

**When writing vault notes:**
- Use the `/write` skill. Call MCP `oms_write`. Do not use host Write/Edit for vault `.md` files.
- The kernel fills and checks frontmatter from `.oms`. `ask` or `rejected` means fix and call `oms_write` again.

**When retrieving knowledge:**
- Use the `/search` skill or follow the retriever persona (`core/agents/retriever.md`).
- Apply the concept's declared lens for the retrieval purpose (synthesis, audit, etc.).
- Return only the fields the lens specifies — do not dump full frontmatter.

**Doctor is advisory. Write is not.**
`oms doctor` always exits 0. MCP `oms_write` rejects contract violations.
