---
name: doctor
description: Diagnose template authority and index problems, then run explicit repairs.
mcp_tool: doctor
mcp_args:
  op: "validate"
---

# doctor

Diagnose vault template and derived-index state, then run only the named repair.

## Usage

```text
/doctor <validate|regenerate-types|backfill-defaults|audit|build-graph|cleanup|sync-embeddings>
```

- `validate` is read-only. It reports policy/projection/source-signature drift, migration marker state, managed source exclusions, and unresolved legacy notes.
- `regenerate-types` recomputes the derived `.oms/types.json` from actual templates, policy, taxonomy, and read-only Obsidian types.
- `backfill-defaults` updates exactly one explicit note with stable template identity while preserving unrelated frontmatter and body bytes.
- `audit` checks notes, optionally scoped by `folder`.
- `build-graph` and `cleanup` repair their derived indexes.
- `sync-embeddings` requires exactly one `mode`: `sync`, `embed`, or `repair`. Repair additionally requires `repairMode: "rebuild"` or `"drop"` and accepts `dryRun`; it backs up the engine store and verifies the resulting rebuilt/absent state. It does not mean forced embedding. Do not send retired boolean `embed` or `force` switches or repair-only fields with sync/embed.

Every note/control repair requires a verified target and current authority. Run a dry-run, review the exact paths, diagnostics, and receipt, then submit its exact `approvalDigest`; never self-approve, repair all notes implicitly, edit controls directly, or treat an unobserved condition as healthy.
