---
name: status
description: Report read-only template, graph, and semantic-index health.
mcp_tool: status
mcp_args: {}
---

# status

Report vault health without changing files.

```text
/status
```

With `status` op absent, show the combined read-only view: resolved template count, current projection/input signature, managed template-source exclusions, template diagnosis state, and graph/semantic-index availability. Use `status { op: "graph" }` only for graph status. Do not send `graph` when requesting the combined view.

A malformed or missing projection is reported as invalid with an actionable doctor operation. Status never regenerates controls, rebuilds indexes, repairs notes, edits controls, or writes the vault. Use `oms graph build` / `doctor { op: "build-graph" }` for graph construction and `oms index sync|embed|repair` for embedding work.

Report runtime history separately: events live outside the vault and are scoped to the current host and vault. A missing event means unobserved, never unused. Distinguish actual mutation time from observation time; external drift gives a changed-between interval, not an invented modification timestamp. Every use/check verifies current authority instead of applying an age-based expiry rule. Surface `LEDGER_APPEND_FAILED` explicitly without claiming a successful vault write failed.
