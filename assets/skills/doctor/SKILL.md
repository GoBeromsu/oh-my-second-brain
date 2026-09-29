---
name: doctor
description: Diagnose the sealed contract and derived indexes, then run only an explicit supported repair. Does not backfill notes.
mcp_tool: doctor
mcp_args:
  op: "validate"
---

# doctor

Report vault health, diagnose the seal and derived indexes, then run only the repair the user named. Do not backfill notes, rewrite note bodies, or edit OMS files by hand. Unknown note values go back to `/write`, not to an invented repair.

```text
/doctor <status|link-check|validate|audit|build-graph|cleanup|sync-embeddings>
```

- `status` is read-only vault health: the seal posture, the count of live templates in the template folder, the generation digest and diagnostics, graph status, the runtime history for this host and vault, whether writes are enabled, and `readTools` (the read-only MCP tools: `search`). It creates nothing and writes nothing, with or without an engine store. `oms doctor status` is the CLI counterpart.
- `link-check` validates one note's `[[wikilinks]]` (`notePath`, optional `folder`) without writing. `oms doctor link-check` is the CLI counterpart and can check the whole vault without a path.
- `validate` is read-only seal diagnosis. It returns the vault, the contract posture with its findings, the `cause` and `recovery` when the seal cannot be read, stale locks, orphaned generations, how many unexpected files sit in the vault's `.oms` folder, and counted hook transport failures. It repairs nothing and prints no rule value or store path.
- `audit` reports which notes would fail the sealed contract, as `{path, field, kind}` entries. It rewrites nothing. `oms doctor audit` is the CLI counterpart.
- `build-graph` and `cleanup` repair the derived graph or semantic index the user named.
- `sync-embeddings` takes exactly one `mode`: `sync`, `embed`, or `repair`. `repair` also requires `repairMode: "rebuild"` or `"drop"` and may set `dryRun`. It backs up the engine store and checks the rebuilt or absent result. It is not forced embedding. Do not send retired boolean `embed` or `force` switches, and do not send repair-only fields with `sync` or `embed`.

A broken or missing seal is recovered by the user running `oms setup` at a terminal; recovery is never done through the `setup` skill. The only automatic seal repair is `oms doctor contract --fix`, which re-indexes a moved or unindexed vault and nothing else. `oms doctor contract` also names the unexpected `.oms` entries for the person at the CLI.

Index repairs run only when explicitly requested and do not edit notes. There is no default-value backfill: OMS never rewrites a note.

The surface is four MCP tools (write, search, interview, doctor) and six skills.
