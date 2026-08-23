---
name: doctor
description: Diagnose vault convention and index problems, then run explicit repairs.
mcp_tool: oms_doctor
mcp_args:
  op: "audit"
---

# doctor

Diagnose vault problems and perform the requested repair.

## Use when

Use this skill when a vault has convention violations, an unhealthy graph or semantic index, or stale generated state that needs correction. Use `status` instead when inspection alone is required.

## Usage

```text
/doctor <audit|validate|build-graph|semantic-cleanup|sync-embeddings>
```

`audit` and `validate` inspect notes against their declared concept schemas. `build-graph`, `semantic-cleanup`, and `sync-embeddings` are repair operations and may write generated graph or semantic-index state. Review the diagnosis, then invoke only the repair needed.
