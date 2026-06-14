---
name: oms-update
description: Update Oh My Second Brain and refresh installed host adapters.
---

# Skill: oms-update (Claude Code)

Update the globally installed Oh My Second Brain package and reconcile host adapter surfaces.

## Invocation

```
/oms-update
```

## What this skill does

Shells out to:

```bash
oms update [--runtime <auto|all|claude|codex|hermes>] [--vault <path>] [--dry-run] [--yes]
```

The CLI will:
1. Check the latest `oh-my-second-brain` version on npm.
2. Print the planned package update and adapter reconciliation commands unless `--yes` is provided.
3. With `--yes`, run `npm install -g oh-my-second-brain@latest`.
4. Refresh host adapter/MCP registrations for the selected runtime.

## Options

| Flag | Description |
|------|-------------|
| `--vault <path>` | Vault path used for MCP registration refresh. |
| `--runtime <name>` | Refresh `auto`, `all`, `claude`, `codex`, or `hermes`. |
| `--dry-run` | Preview update and reconciliation commands without mutating anything. |
| `--yes` | Perform the package update and adapter reconciliation. |
| `--execute` | Allow external host CLIs during reconciliation where available. |

## Example

```bash
oms update --dry-run --runtime all --vault ~/Documents/MyVault
oms update --yes --runtime all --vault ~/Documents/MyVault
```
