---
name: oms-uninstall
description: Remove Oh My Second Brain host adapter and MCP registrations by running oms uninstall.
---

# Skill: oms-uninstall (Claude Code)

Remove Oh My Second Brain host registrations and adapter files. This does **not** delete vault notes or `vault/.oms/` ontology data.

## Invocation

```
/oms-uninstall
```

## What this skill does

Shells out to:

```bash
oms uninstall [--runtime <all|claude|codex|hermes>] [--dry-run] [--execute] [--yes]
```

## Recommended flow

```bash
# Preview first:
oms uninstall --runtime all --dry-run

# Remove Oh My Second Brain host registrations:
oms uninstall --runtime all --yes
```

Use `--execute` only when you want Oh My Second Brain to call external host CLIs such as the scoped `claude mcp remove oms --scope local|project|user` commands or `claude plugin uninstall oms`.
