---
name: status
description: Report read-only vault health, statistics, and index state.
mcp_tool: oms_status
mcp_args: {}
---

# status

Report the current state of a vault without changing it.

## Use when

Use this skill to inspect vault health and statistics before deciding whether maintenance is needed.

## Usage

```text
/status
```

Report note counts, semantic-index availability and freshness, and graph-cache status. Status is observational only: it never rebuilds an index, repairs notes, or writes vault files.
