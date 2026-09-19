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

## Template-change notices

`status` is the read-only polling channel for selected-folder template changes.
When a machine `templateNotice` is present, return the full notice on every
poll and surface the initial display exactly as `템플릿에 변경이 있습니다`
with exactly `확인하기` and `나중에`. Do not render a template name, hash, or
change taxonomy in that first notice. A census failure yields no notice and no
tool error.

`나중에` is host-only: it performs no server call and leaves the pending set and
interview ledger unchanged. `확인하기` starts
`write { op: "template", mode: "interview-next" }`; subsequent answers use
`interview-answer` with the server-returned question, request, and CAS values.
Resume from the returned next question, preserve unaffected confirmed answers,
and proceed directly to final confirmation when there are zero questions.
`commit-contracts` publishes only after the user approves the exact final
digest; never self-approve.

Long-lived sessions must surface this tool-result notice even if boot
instructions are stale. The five-MCP-tool/seven-skill surface and read-only
status contract remain unchanged.
