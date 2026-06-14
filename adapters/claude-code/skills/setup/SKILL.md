---
name: oms-setup
description: Adopt an existing Obsidian vault into the Oh My Second Brain convention by running oms setup.
---

# Skill: oms-setup (Claude Code)

Adopt your Obsidian vault into the Oh My Second Brain convention.
This skill is **REAL in v0** — it shells out to the fully-implemented CLI.

## Invocation

```
/oms-setup
```

## What this skill does

Shells out to:

```bash
oms setup [--vault <path>] [--yes] [--suggest-fields] [--install-claude]
oms install [--runtime <auto|all|claude|codex|hermes>] [--vault <path>] [--dry-run] [--execute] [--yes]
```

The CLI will:
1. Scan your vault's existing top-level folders (does NOT impose a structure).
2. Interactively ask each folder's intent and concept binding (use `--yes` to accept defaults).
3. Summarize observed frontmatter fields without changing notes.
4. Optionally add selected observed fields to concept schemas with `--suggest-fields`.
5. Ask for retrieval lenses and reject lenses that reference unknown fields.
6. Write `vault/.oms/taxonomy.yaml` and preserve existing `vault/.oms/concepts/` files while adding missing defaults.

## Options

| Flag | Description |
|------|-------------|
| `--vault <path>` | Path to your Obsidian vault root (default: current directory) |
| `--yes` | Non-interactive: accept all defaults, no prompts |
| `--suggest-fields` | Merge observed note frontmatter fields into concept schemas without mutating notes. |
| `--install-claude` | Legacy setup-only dry-run that prints Claude Code plugin install and MCP registration commands. |
| `install --runtime <name>` | Install host adapter/MCP registration for `auto`, `all`, `claude`, `codex`, or `hermes`. |
| `install --dry-run` | Preview host writes without mutating config. |
| `install --execute` | Allow external host CLIs such as `claude plugin install` to run when available. |

## Example

```bash
# Interactive (recommended first run):
oms setup --vault ~/Documents/MyVault

# Interactive setup with observed frontmatter field suggestions:
oms setup --vault ~/Documents/MyVault --suggest-fields

# Non-interactive (CI / scripted):
oms setup --vault ~/Documents/MyVault --yes

# Preview all host adapter installs:
oms install --runtime all --vault ~/Documents/MyVault --dry-run

# Install all host adapter/MCP registrations:
oms install --runtime all --vault ~/Documents/MyVault --yes

# Also run external host CLIs where available:
oms install --runtime claude --vault ~/Documents/MyVault --yes --execute
```

## After setup

Run `/oms-doctor` to validate your existing notes against the convention.

## Roadmap

Setup plus `oms install`/`oms uninstall` host lifecycle commands are real and release-gated by unpacked npm tarball smoke tests. The MCP command starts
the status/read/cache/retrieve/capture runtime (`oms_graph_status`, `oms_graph_build`,
`oms_list_concepts`, `oms_retrieve_context`, `oms_retrieve_by_axis`,
`oms_lazy_load_note`, `oms_validate_contract`, `oms_capture_prepare`,
`oms_capture_commit`).
Capture commit is gated by path-safety and contract validation.
