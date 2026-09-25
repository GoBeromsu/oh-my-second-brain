---
name: doctor
description: Diagnose the sealed contract and derived indexes, then run only an explicit supported repair. Does not backfill notes.
mcp_tool: doctor
mcp_args:
  op: "validate"
---

# doctor

Diagnose the seal and derived indexes, then run only the repair the user named. Do not backfill notes, rewrite note bodies, or edit OMS files by hand. Unknown note values go back to `/write`, not to an invented repair.

```text
/doctor <validate|audit|build-graph|cleanup|sync-embeddings>
```

- `validate` is read-only seal diagnosis. It returns the vault, the contract posture with its findings and template states, the `cause` and `recovery` when the seal cannot be read, stale locks, orphaned generations, how many unexpected files sit in the vault's `.oms` folder, and counted hook transport failures. It repairs nothing and prints no rule value or store path.
- `audit` reports which notes would fail the sealed contract, as `{path, field, kind}` entries. It rewrites nothing. `oms note audit` is the CLI counterpart.
- `build-graph` and `cleanup` repair the derived graph or semantic index the user named.
- `sync-embeddings` takes exactly one `mode`: `sync`, `embed`, or `repair`. `repair` also requires `repairMode: "rebuild"` or `"drop"` and may set `dryRun`. It backs up the engine store and checks the rebuilt or absent result. It is not forced embedding. Do not send retired boolean `embed` or `force` switches, and do not send repair-only fields with `sync` or `embed`.

A broken or missing seal is recovered by the user running `oms setup` at a terminal; you never run it. The only automatic seal repair is `oms contract doctor --fix`, which re-indexes a moved or unindexed vault and nothing else. `oms contract doctor` also names the unexpected `.oms` entries for the person at the CLI.

Index repairs run only when explicitly requested and do not edit notes. There is no default-value backfill: OMS never rewrites a note.

The surface is five MCP tools and six skills.
