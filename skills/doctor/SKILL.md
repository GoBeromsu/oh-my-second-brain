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
- `build-graph`, `cleanup`, and `sync-embeddings` repair derived indexes.

Every note/control repair requires a verified target. Run a dry-run, review the receipt, then submit its exact `approvalDigest`; never self-approve or repair all notes implicitly.
