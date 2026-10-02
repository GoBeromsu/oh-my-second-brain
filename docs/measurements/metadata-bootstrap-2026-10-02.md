# Observed-only metadata bootstrap

An observed-field filter or facet request without lexical text previously built
the entire detached FTS corpus before using only its parsed metadata. These
requests now capture Markdown and use the existing projection/EAV cache without
opening a lexical store or creating chunks. This is a metadata startup change;
the later first lexical or mixed request still builds the complete canonical
chunk corpus before returning ranked results.

The compact source inventory is published only after capture workers and root
validation finish. It is separate from the native lexical source evidence.
Queued lexical upgrades wait outside the active-reader count until metadata
selectors have captured their results; disposal rejects a waiting upgrade.
Weak-byte witnesses, edits/deletes/renames, backing spill, typed equality, cursor
scope, final source checks and read-only persistent-state semantics are preserved.

## Controlled synthetic comparison

The anonymous fixture contains 20,000 Markdown notes and 199,230,000 bytes with
varied body widths, Unicode and frontmatter shapes. It is synthetic and does not
claim the distribution of any private vault. Cloud Linux used Node 24.19.0 and
SQLite 3.53.1. Control commit `5b2d44343250ac812b1654f7341c659935395c80` matches the
published #213 tree; candidate `ad8d736fd55d7ee3bebc08bf760f85ab5f1c3366` includes
the metadata change and prerequisite documentation.

Each arm ran three fresh CLI processes with observed key discovery, limit 20,
and zero requested note hits. Order was control, candidate, candidate, control,
control, candidate. Known competing jobs were held from 15:53:20 to 15:57:22 UTC.
Fixture creation and complete byte guards were outside timing. OS caches were
not dropped, and guards/earlier runs warm them. An exit-only resource hook was
used; no per-stage profiling ran during the comparison.

| Measure | Control | Candidate |
| --- | --- | --- |
| Median metadata-only cold CLI time | 32.525 s | 18.888 s |
| Observed range | 32.519–38.459 s | 18.433–19.713 s |
| Maximum RSS across runs | 486–515 MiB | 435–446 MiB |

The median reduction is 41.93% for this metadata-only workload. All six complete
responses matched exactly. Vault/home/cache byte images remained unchanged and
all sessions cleaned their temporary files. This does not measure standalone
lexical cold latency or establish actual-host deadline success.

## Correctness and limits

The implementation passed 248 focused tests and independent review passed 55
overlapping tests. The combined aggregate passed 3,668 tests with 12 skips and
only the known sandbox Unix-socket `EPERM` failure. Lint/build/docs passed.
These counts are separate evidence sets, not additive totals.

`node scripts/bench/metadata-bootstrap-repro.mjs` is a small synthetic correctness
proof after building: observed discovery/filtering and an external edit keep
lexical pages at zero, a later lexical request finds the edit, and no persistent
index is created. It is not the timed corpus. Metadata-only reads still enumerate
the vault and capture/parse notes on a cold process; they are not a persistent
cache or a background indexer. Warm MCP sessions and new CLI processes therefore
have different costs. No notes, persistent indexes, models or host settings are
changed by queries.

A separate fresh synthetic 20k MCP session passed the unchanged default SDK
deadline: observed discovery took 18.42 s, warm value discovery 2.02 s, exact
selection 2.10 s, the later first lexical/mixed query 26.27 s, and warm lexical
retrieval 2.40 s. Facet counts and results matched the fixture, stderr was empty,
source/home/cache byte images were unchanged, and client shutdown removed all
temporary directories. This was a correctness journey outside the paired timing
window, not an additional controlled performance comparison or host validation.
