# Indexed Unicode token accounting

This narrow change replaces per-codepoint string iterator work while counting
approximate tokens. It uses indexed `codePointAt` and skips the
second UTF-16 unit only when the decoded value exceeds `0xffff`. The existing CJK
ranges and integer quarter-token weights are unchanged. Valid surrogate pairs,
lone surrogates, supplementary CJK and other supplementary characters retain
the same weights, chunk boundaries, text, titles, headings, ordinals and digests.

## Diagnostic motivation

A new instrumented cold run on the existing anonymous 20,000-note fixture took
24.099 seconds; its uninstrumented control took 21.219 seconds. The instrumentation
added 13.57%, so its stage totals are diagnostic, not performance claims.

- Canonical frontmatter parsing: 4.631 seconds
- Chunking: 3.777 seconds, including 2.197 seconds across 2,035,694 token-weight calls
- Native document/batch reconciliation transactions: 4.627 seconds combined
- Empty detached seed: 7.1 milliseconds; first lexical query: 0.7 milliseconds

Nested stage totals overlap. Concurrent source-read totals also overlap heavily
and cannot be added to wall time. The token-weight timer in particular pays
per-call instrumentation overhead. The following comparison removes those hooks.
No source-witness, SQLite durability, batching or schema change was made.

## Controlled synthetic comparison

Cloud Linux x64, Node 24.19.0 and SQLite 3.53.1. Control source is
`468ffce760d3c32ad8962f843f1a7999de0db1f2`; current main `d1fdbef` has the same
runtime and differs only in README artwork/documentation. The measured candidate
changes only the token-weight loop in `src/kernel/engine/embed/chunker.ts`.

The unchanged fixture contains 20,000 Markdown notes and 199,230,000 source bytes,
with varied line widths, scripts and metadata shapes. Its generator and caveats
are in [the earlier cold lexical measurement](./cold-lexical-2026-10-02.md).
This is not a measured private-vault distribution.

Six fresh CLI processes ran in the order control, candidate, candidate, control,
control, candidate against the same fixture. Each queried `coldneedle` with limit
10 and had isolated HOME, cache and temporary directories, no persistent index,
and no warm session. Known competing work was asked to hold during the timing
window. OS caches were not dropped; byte guards outside the timer warm them.
An exit-only resource hook recorded CPU/RSS. Timers include process startup and
shutdown, but exclude fixture creation and source/state checks.

| Measure | Control | Candidate |
| --- | ---: | ---: |
| Median wall time | 20.957 s | 19.177 s |
| Observed wall-time range | 20.855–21.168 s | 18.602–20.076 s |
| Observed peak RSS range | 547.8–549.7 MiB | 533.1–588.2 MiB |

The median reduction is **8.50% on this synthetic workload**. The small sample
does not establish statistical bounds or a memory improvement. All six complete
CLI responses have SHA-256
`faad1dd4ff8261565af8b79aaa5f707f7319560b8fc87640747a239af0c3aec1`.
Every run preserved source/HOME/cache bytes and cleaned its temporary storage.

## Correctness and boundaries

Independent differential checks compare all 1,114,112 Unicode codepoints,
6,859 representative UTF-16 triples, and 10,680 complete chunk outputs spanning
CJK range boundaries, malformed surrogate sequences and 120 option combinations.
The existing 150-case golden test remains unchanged; another baseline-pinned
golden covers every CJK interval boundary and supplementary/isolated surrogates.

A separate full-fixture comparison matched all 74,666 complete chunks across all
20,000 notes, with aggregate SHA-256
`c06e2b9034aa1013cd0cf2191e27c543c4f2b322cc5453af2b360a17f45c8a7c`.

The first lexical query still captures the complete corpus. Ranking, counts,
cursors, source witnesses, private-store budgets, persistent-store policy,
maintenance opt-in and ownership cleanup are unchanged. This result does not
establish that an actual user's first lexical MCP request meets the default
60-second deadline, nor validate an installed host runtime. No timeout increase,
prewarming, persistent index creation, release or deployment is included.

Build the selected control/candidate and run the existing
`scripts/bench/cold-lexical-repro.mjs` helper with its 20,000-note defaults in an
external scratch directory. Alternate fresh processes in a quiet window; keep
instrumented stage diagnostics separate from ordinary timing measurements.
