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
/doctor <status|link-check|validate|audit|build-graph|cleanup|sync-embeddings|evolve|evolve-verdict|revert-propose>
```

- `status` is read-only vault health: the seal posture, the count of live templates in the template folder, the generation digest and diagnostics, graph status, the runtime history for this host and vault, the contract `evolution` summary (journal counters, requests awaiting the owner, the autonomous budget left, whether the lineage has a gap), whether writes are enabled, and `readTools` (the read-only MCP tools: `search`). It creates nothing and writes nothing, with or without an engine store. `oms doctor status` is the CLI counterpart.
- `link-check` validates one note's `[[wikilinks]]` (`notePath`, optional `folder`) without writing. `oms doctor link-check` is the CLI counterpart and can check the whole vault without a path.
- `validate` is read-only seal diagnosis. It returns the vault, the contract posture with its findings, the `cause` and `recovery` when the seal cannot be read, stale locks, orphaned generations, how many unexpected files sit in the vault's `.oms` folder, and counted hook transport failures. It repairs nothing and prints no rule value or store path.
- `audit` reports which notes would fail the sealed contract, as `{path, field, kind}` entries. It rewrites nothing. `oms doctor audit` is the CLI counterpart.
- `build-graph` and `cleanup` repair the derived graph or semantic index the user named.
- `sync-embeddings` takes exactly one `mode`: `sync`, `embed`, or `repair`. `repair` also requires `repairMode: "rebuild"` or `"drop"` and may set `dryRun`. It backs up the engine store and checks the rebuilt or absent result. It is not forced embedding. Do not send retired boolean `embed` or `force` switches, and do not send repair-only fields with `sync` or `embed`.

- `evolve` turns the open write gaps into one contract evolution request and returns its request id, nonce, digests and evaluator slots. It seals nothing. You are the maker: do not judge your own request.
- `evolve-verdict` submits one evaluator verdict (`approve` or `reject`, with `rubricScores` and `reasons`) bound to a request slot. Each verdict must come from a separate evaluator subagent that did not draft the request. A host that cannot run independent evaluator subagents must not submit verdicts at all: stop and tell the user to review the request at `oms setup`. Nothing is sealed without three bound verdicts. A candidate that adds a refusal is rejected; one that loosens the contract or raises warnings waits for the owner; only a candidate with no new refusal and a warning delta of 0 or less can seal on its own, and only when the owner turned autonomy on.
- `revert-propose` (`targetDigest`) proposes a kept generation's contract as a new forward candidate that goes through the same gate. It never rewrites history.
- `reclaim-evolution-lock` and `lineage-reanchor` belong to the owner at a terminal; over MCP they are refused. Tell the user to run `oms doctor reclaim-evolution-lock` or `oms doctor lineage-reanchor` themselves. Requests awaiting the owner are approved or rejected only at `oms setup`, and autonomy is turned on only with `oms setup --autonomy on`.

A broken or missing seal is recovered by the user running `oms setup` at a terminal; recovery is never done through the `setup` skill. The only automatic seal repair is `oms doctor contract --fix`, which re-indexes a moved or unindexed vault and nothing else. `oms doctor contract` also names the unexpected `.oms` entries for the person at the CLI.

Index repairs run only when explicitly requested and do not edit notes. There is no default-value backfill: OMS never rewrites a note.

The surface is four MCP tools (write, search, interview, doctor) and six skills.
