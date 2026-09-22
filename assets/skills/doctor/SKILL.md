---
name: doctor
description: Diagnose contract controls and indexes, then run only an explicit owned repair. Does not backfill notes.
mcp_tool: doctor
mcp_args:
  op: "validate"
---

# doctor

Diagnose `.oms` controls and derived indexes, then run only the repair the user named. Do not backfill notes, rewrite note bodies, or edit control files by hand. Unknown note values go back to `/write`, not to an invented repair. Contract meaning changes go to `/interview`.

```text
/doctor <validate|regenerate-types|build-graph|cleanup|sync-embeddings>
```

- `validate` is read-only. It reports policy, projection, and source-signature drift, the contract transaction marker, and managed-source exclusions. Unobserved is not healthy. A damaged policy is unverifiable; do not substitute an empty contract. Version 3 is unsupported and is not migrated here.
- `regenerate-types` recomputes derived `.oms/types.json` from the approved policy, taxonomy, and read-only Obsidian types. Dry-run first, then submit that returned `approvalDigest` as `approvedDigest`. This does not repair notes.
- `build-graph` and `cleanup` repair the derived graph or semantic index the user named.
- `sync-embeddings` takes exactly one `mode`: `sync`, `embed`, or `repair`. `repair` also requires `repairMode: "rebuild"` or `"drop"` and may set `dryRun`. It backs up the engine store and checks the rebuilt or absent result. It is not forced embedding. Do not send retired boolean `embed` or `force` switches, and do not send repair-only fields with `sync` or `embed`.

Note-contract reporting is `oms note audit`. It is not a note rewrite. Index repairs run only when explicitly requested and do not edit notes. Never self-approve a projection publish.

## Parent alignment

The live doctor schema may still advertise `audit` and `backfill-defaults`. Do not call them. Note reporting is `oms note audit`, and it does not rewrite notes. `validate` remains the read-only control diagnosis.
