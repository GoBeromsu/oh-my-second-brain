# Avoiding empty detached FTS deletes

This is a narrow correction to fresh-document batching. The detached reconciler
already reads the stored chunk set. Clearing a known-empty set is unnecessary,
and a virtual-table DELETE can flush pending FTS terms even when it matches no
rows. The native regression changes four segments for four new documents in one
transaction into one segment, with identical ranked results. Run
`node scripts/bench/fts-empty-delete-repro.mjs` for the standalone in-memory proof.

The production change only skips that clear when no chunk rows exist. Nonempty
replacements/deletes, source verification, rollback, durability, canonical chunks
and full-corpus ranking retain their existing behavior. This does not remove the
complete source capture required by a first lexical query.

## Controlled synthetic comparison

The unchanged anonymous fixture has 20,000 Markdown notes and 199,230,000 input
bytes. These notes are synthetic; this is not a private-vault distribution or host
measurement. Cloud Linux used Node 24.19.0 and SQLite 3.53.1. The control was local
`30976a9230f439d560b313da53bc053d0f4b09a5` (the exact published #212 tree); the
candidate was `2ad685bcc2e61df19c06ca2efef7147576a3fe35`.

Three fresh CLI runs per arm alternated control, candidate, candidate, control,
control, candidate. Known competing jobs were paused from 15:12 to 15:15:53 UTC.
Fixture creation and complete byte guards were outside timing. OS caches were
not dropped; guards and earlier runs warm filesystem caches. An exit hook recorded
process resource usage without per-stage instrumentation.

| Measure | Control | Candidate |
| --- | --- | --- |
| Median cold CLI time | 23.877 s | 22.947 s |
| Observed range | 23.801–24.874 s | 22.812–23.449 s |
| Maximum RSS across runs | 460–496 MiB | 478–508 MiB |

The median reduction is 3.89% on this workload. All six complete responses were
identical, every vault/home/cache byte image was unchanged, and every session
removed its temporary files. Peak RSS overlaps; no memory improvement is claimed.
This modest gain does not establish actual-vault success within the default
60-second MCP deadline. That availability issue remains open.

The native segment test failed on the unchanged baseline and passed after the
condition changed. Seven relevant suites passed 115 tests. Independent review
passed 25 overlapping tests plus memory/disk probes for empty-note source and
revision invalidation, malformed records, failed publication and byte-preserving
rollback. These are separate evidence sets, not additive test counts.

The final local aggregate passed 3,635 tests with 12 skips and only the known
sandbox Unix-socket `EPERM` failure. Lint, build, documentation, measurement gate
and production dependency audit passed; the audit found zero vulnerabilities.
