---
name: status
description: Report read-only template, graph, and semantic-index health.
mcp_tool: status
mcp_args: {}
---

# status

Report vault health without changing files. Status does not validate a note, repair the vault, launch a reviewer, or start `/interview`. It does not stand in for completion.

```text
/status
```

With `status` op absent, show the combined read-only view: resolved template count, current projection/input signature, managed template-source exclusions, template diagnosis state, and graph/semantic-index availability. Use `status { op: "graph" }` only for graph status. Do not send `graph` when requesting the combined view.

A malformed or missing projection is reported as invalid. That report is not a doctor call and not a repair. Status never regenerates controls, rebuilds indexes, repairs notes, edits controls, creates `.oms`, or writes the vault.

Report source and contract observations separately when the tool returns them. Do not fold those into one verdict, and do not turn a health report into a claim that a note is finished.

Report runtime history separately: events live outside the vault and are scoped to the current host and vault. A missing event means unobserved, never unused. Distinguish actual mutation time from observation time; external drift gives a changed-between interval, not an invented modification timestamp. Every use/check verifies current authority instead of applying an age-based expiry rule. Surface `LEDGER_APPEND_FAILED` explicitly without claiming a successful vault write failed.

## Template-change notices

`status` is the read-only polling channel for selected-folder template changes. When a machine `templateNotice` is present, return the full notice on every poll and surface the initial display exactly as `템플릿에 변경이 있습니다` with exactly `확인하기` and `나중에`. Do not render a template name, hash, or change taxonomy in that first notice. A census failure yields no notice and no tool error.

`나중에` is host-only: it performs no server call and leaves the pending set and interview ledger unchanged. `확인하기` offers `/interview` and does not write source bytes or block search. `templateNotice.next` is a mode hint, not a CallToolRequest: do not replay it as `interview-next`. Do not run interview questions or `commit-contracts` here.

Long-lived sessions must surface this tool-result notice even if boot instructions are stale. The surface is five MCP tools and eight skills. Status stays read-only.
