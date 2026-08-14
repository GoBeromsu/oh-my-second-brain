# Oh My Second Brain for Codex

Use Oh My Second Brain when the user asks to set up, validate, capture into, retrieve from, or inspect an Obsidian/Markdown vault governed by `vault/.oms/`.

## Core rule

Oh My Second Brain is a convention harness, not a content generator. The user owns the ontology in `vault/.oms/`; agents must use the declared folder axis, frontmatter/property axes, wikilinks, and retrieval lenses before reading or writing notes.

## Command mapping

| User intent | Preferred Oh My Second Brain surface |
|---|---|
| adopt a vault | `$oms-setup` or `oms setup --vault <path>` |
| install host integration | `$oms-install` or `oms install --runtime codex --vault <path> --yes` |
| uninstall host integration | `$oms-uninstall` or `oms uninstall --runtime codex --yes` |
| validate notes | `$oms-doctor` or `oms doctor --vault <path>` |
| write a vault note | use `$oms-write` / MCP `write` (`create`, `append`, or `update`) |
| retrieve knowledge | use MCP `oms_retrieve_context`, then `oms_lazy_load_note` only when needed |

## Safety

- Never delete vault notes or `vault/.oms/` during uninstall.
- Capture must stay inside the configured vault and target Markdown files only.
- If required frontmatter is missing, ask for it; do not invent user-owned ontology values.
- Route ambiguous captures to inbox when the ontology cannot decide.
