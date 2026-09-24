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
/doctor <validate|build-graph|cleanup|sync-embeddings>
```

- `validate` is read-only. It returns the vault, an aggregate `status` of `healthy` or `needs-repair`, the published `revision`, whether the portable settings are `verified` or `missing`, and one diagnostic per problem it found: a held registration, a drifted source, a missing original, or a source that cannot be read. An unchanged source produces no entry, so silence means no problem was observed rather than a per-source report. Unobserved is not healthy. A policy that is missing, damaged, or unreadable is reported as that; do not substitute an empty contract. A historical version-3 or version-4 policy is diagnosed here, never migrated here: migration happens only when a mutating selection asks for it.
- `build-graph` and `cleanup` repair the derived graph or semantic index the user named.
- `sync-embeddings` takes exactly one `mode`: `sync`, `embed`, or `repair`. `repair` also requires `repairMode: "rebuild"` or `"drop"` and may set `dryRun`. It backs up the engine store and checks the rebuilt or absent result. It is not forced embedding. Do not send retired boolean `embed` or `force` switches, and do not send repair-only fields with `sync` or `embed`.

Note-contract reporting is `oms note audit`. It is not a note rewrite. Index repairs run only when explicitly requested and do not edit notes. Never self-approve a projection publish.

## Surface

`validate` is the read-only contract diagnosis: it reports an aggregate status, the published revision, whether the portable settings are verified, and one diagnostic per problem found among held registrations and registered sources. It repairs nothing. A contract change is published through `/interview`, and a changed source is acknowledged or relinked there. There is no `backfill-defaults` and no derived-projection repair: OMS never rewrites a note, and the explicit contract is the authority rather than something derived from it. Note reporting is `oms note audit`, which reports and repairs nothing.
