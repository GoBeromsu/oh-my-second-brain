---
name: status
description: Report read-only contract, runtime-history, and graph health.
mcp_tool: status
mcp_args: {}
---

# status

Report vault health without changing files. Status does not judge a note, repair the vault, or reseal the contract. It does not stand in for completion.

```text
/status
```

With `op` absent, `status` returns the combined read-only view:

- `contract`: the seal posture (`sealed`, `none`, or `unreadable`), its findings, and each sealed template by name with a state of `active`, `drift`, or `missing` against the live template file. No rule value, store path, or contract body is returned.
- `counts`: how many templates are sealed, or null when there is no readable seal.
- `generationDigest` and `diagnostics` for the derived state.
- The runtime history for this host and vault.
- `engineGraph`: graph status.
- `writeTools` and `readTools`: whether writes are gated by a verified target and a readable contract, or disabled and why.

Use `status { op: "graph" }` only for graph status. Do not send `graph` when requesting the combined view.

A drifted or missing template is reported, never resealed here. The fix is the user running `oms setup` at a terminal; you never run it. `oms contract status` shows the same posture and template states from the CLI.

Status never rebuilds indexes, repairs notes, creates `.oms`, or writes the vault. Do not turn a health report into a claim that a note is finished.

Report runtime history separately: events live outside the vault and are scoped to the current host and vault. A missing event means unobserved, never unused. Distinguish actual mutation time from observation time; external drift gives a changed-between interval, not an invented modification timestamp. Surface `LEDGER_APPEND_FAILED` explicitly without claiming a successful vault write failed.

The surface is five MCP tools and six skills.
