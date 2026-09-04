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

Show resolved template count, current projection/input signature, managed template-source exclusions, template diagnosis state, and graph/semantic-index availability. A malformed or missing projection is reported as invalid with an actionable doctor operation. Status never regenerates controls, rebuilds caches, repairs notes, or writes the vault.
