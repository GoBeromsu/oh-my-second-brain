---
name: oms-update
description: Update Oh My Second Brain and refresh installed host adapter registrations.
---

# oms-update

Use when the user wants to update Oh My Second Brain after it has already been installed.

Preview first:

```bash
oms update --dry-run --runtime all --vault <vault>
```

Perform the update:

```bash
oms update --yes --runtime all --vault <vault>
```

`oms update` checks npm for the latest `oh-my-second-brain` release, installs `oh-my-second-brain@latest` only when `--yes` is present, then reconciles host adapter/MCP registrations through the same install path. Without `--yes`, it prints the planned commands and does not mutate package or host config.
