# Bounded disk-backed lexical batch measurement

Date: 2026-10-02. Cloud Linux, Node 24.19.0, SQLite 3.53.1.

## Change and boundaries

Large cold lexical captures previously committed each document separately. After
the private corpus spills to disk, this change groups already captured documents
into synchronous native transactions. The queue owns V8-serialized canonical
chunks and source evidence, including titles, headings, paths and digests. It
admits at most 32 records and 1,024 chunks, with whole backing-buffer allocations
plus 512 bytes per record charged against 4 MiB. An oversized document is handled
alone; obviously oversized records bypass serialization.

SQLite's [FTS5 savepoint callback](https://github.com/sqlite/sqlite/blob/master/ext/fts5/fts5_main.c)
flushes pending terms. The dedicated reconciler therefore reuses its owned outer
transaction instead of opening redundant inner savepoints. A scoped flag, reset
with `finally`, limits that behavior to reconciliation. Ordinary store operations,
including failures caught inside a revision transaction, retain their own atomic
rollback guards. Persistent store bindings and durability settings are unchanged.

In-memory capture still commits one complete document before checking its page
budget. Pending FTS data is not fully represented by page counts inside a
transaction, so batching starts only after spill. Source-map publication follows
successful SQL commit. Residual records flush before retrieval; failed batches
roll back, source readers drain, and incomplete refreshes return no result. A SQL
transaction is not atomic with an external Markdown save: the existing final
source and preview validation still applies.

The queue limit is not a process RSS cap. Source reads, parsing, decoded records,
native FTS work and one oversized note require additional transient memory. The
server's existing request-cancellation behavior is unchanged.

## Control, candidate and method

The unchanged control is local commit
`9704fd80636fef7970c753ba1b70abb4a21e476a`, equivalent to draft #210's remote
`d42e0fd25f50c8a45d5b7e4aa03286b94eea316a` at tree
`0e9306342c7ec5711ffe7511c337aed6ace482bc`. The measured candidate is
`b0b4620e3355bfc4549b594f500b6c26cba63d38`, tree
`c46d156a17cde91f827c488d9cbefd08fd4fa6b1`. Delivery stacks the independent MCP
shutdown correction and adds documentation/tests; the measured kernel source is
unchanged.

The existing anonymous fixture contains 20,000 Markdown notes and 199,230,000
input bytes. It varies line lengths, scripts and metadata shapes, including
malformed/unclosed frontmatter. It is not a measured private-vault distribution.
The generator and fixture recipe are in
[the cold lexical measurement](./cold-lexical-2026-10-02.md).

Six fresh CLI processes ran in the order control, candidate, candidate, control,
control, candidate, querying `coldneedle` with limit 10 and no persistent index.
Known competing CPU jobs were paused. OS file caches were not dropped; source,
HOME and cache byte checks outside the timer also warm filesystem caches. Wall
time includes process startup and shutdown. The only instrumentation was an
exit resource report, not per-function timing.

## Results

| Fresh CLI, no persistent index | Control | Candidate |
| --- | ---: | ---: |
| Median wall time | 27.798 s | 24.856 s |
| Wall-time range | 27.588–28.059 s | 24.102–25.677 s |
| Process maximum RSS range | 425.5–430.2 MiB | 462.0–587.1 MiB |

The median reduction is **10.58% on this synthetic workload**, with a higher
measured memory peak. All six complete CLI outputs were the same 2,778 bytes
with SHA-256 `faad1dd4ff8261565af8b79aaa5f707f7319560b8fc87640747a239af0c3aec1`.
Source/HOME/cache byte invariance and temporary cleanup passed in every run.

A single seeded-cold pair took 25.885 s control and 25.519 s candidate, with
maximum RSS about 732 MiB and 730 MiB. This is a near-neutral guardrail, not a
separate speedup claim. Three retained-session limit-0 queries per build took
2.136–2.300 s control and 2.174–2.233 s candidate, with zero body captures and
matching responses. Their ranges overlap; this change does not establish a warm
search improvement. Separate CLI invocations do not share that warm session.

## Memory diagnostic

A separate diagnostic used explicit GC and weak references. Those hooks were
absent from the timing runs and are not production behavior. The candidate
serialized 15,104 queued records, allocating 267,295,398 backing-buffer bytes
cumulatively. After completed capture and diagnostic GC, no recorded serialized
buffer remained reachable, and retained queued-record count was zero.

Post-GC heap usage was 66.9 MiB control and 67.6 MiB candidate, with 2.3 MiB
external memory in each. The candidate diagnostic itself retains weak-reference
bookkeeping. After three warm queries and GC, RSS was 529.8 and 530.3 MiB. These
observations do not remove the higher uninstrumented cold peak, establish a
general memory reduction, or promise that an allocator immediately returns freed
memory to the OS. The performance/memory tradeoff remains explicit.

## Correctness and lifecycle evidence

Focused coverage includes full/residual batches, buffer backing capacity,
metadata-heavy and oversized records, empty notes, spill transitions, real native
constraint errors, multi-document rollback, retry, and source-reader draining.
The in-memory path is asserted not to queue; ordinary upsert/clear failures caught
inside revision transactions remain atomic after successful and failed batches.
The affected eight-suite run passed 167 tests; independent review passed 124
overlapping tests. These counts are not additive.

An independent process probe interrupted a real four-document disk transaction
after its third source publication. The persistent main/WAL/SHM byte images were
unchanged; a new session ignored abandoned scratch, rebuilt from Markdown and
passed final freshness checks. Normal CLI cleanup and idempotent disposal also
passed. Forced process termination can still leave an orphan directory.

A separate full-corpus verification found all 20,000 expected documents and 207
distributed sentinels. Native result hashes, folder facets, subject counts and
exact subject/date selections matched the earlier unchanged control evidence.
Malformed/unclosed notes remained lexical candidates, and query byte invariance
and cleanup passed.

A separate copied 20,000-note fixture exercised 256 metadata/body edits, 16
deletions, 16 renames, eight recreations, eight new notes, and a 5 MB oversized
body. The resulting 20,000-path inventory, all 273 lexical matches, and the exact
272-note observed-field selection agreed. Native writes used bounded batches,
with the oversized document alone; query byte invariance and cleanup passed.
This was a correctness run, not a controlled latency measurement. An earlier
helper assertion incorrectly equated a large body with many chunks; the retained
failure log and corrected byte-based assertion make that distinction explicit.

The default-MCP end-to-end check exposed a pre-existing shutdown bug: a completed
disk-backed query could leave scratch when stdin closed because graceful disposal
was registered only with maintenance enabled. The separate shutdown correction
has a red baseline proof and EOF/SIGINT/SIGTERM tests with maintenance off and on.
With that correction, a fresh synthetic 20,000-note MCP call returned the expected
result under the unchanged SDK deadline, preserved source/cache bytes and cleaned
its temporary state. Its one-off 23.193 s request time is not a paired benchmark.

The measured batching tree passed 3,628 tests with 12 skips and the known baseline
Unix-socket `listen EPERM` failure in this cloud sandbox. The combined production
tree with the shutdown fix passed 3,629 tests with the same skips and baseline
failure; the expanded shutdown matrix subsequently passed all six cases. Lint,
build, documentation checks and the unchanged production dependency audit passed;
the audit reported zero vulnerabilities. Final publication checks are recorded
with the exact delivered tree.

A complete first-use corpus is still required. These results do not establish
that a user's vault satisfies the 60-second MCP deadline or certify an installed
host runtime. Actual-vault QA remains separate. No private notes, field values or
private measurements appear in this evidence.

## Reproduce

Build the selected control/candidate with their pinned dependencies and run the
existing standalone anonymous fixture helper in external scratch storage:

```sh
npm run build
node scripts/bench/cold-lexical-repro.mjs \
  --notes 20000 --bytes 199229440 \
  --work /absolute/external/scratch \
  --checkout /absolute/selected/checkout \
  --output /absolute/external/result.json
```

For comparison, use the same fixture and alternate fresh processes in a
coordinated quiet window. The delivery artifact retains the executed comparison,
seeded/warm, memory-diagnostic, MCP and burst helpers with their synthetic results
and failure logs. Explicit-GC diagnostics must not be substituted for ordinary
latency or memory measurements.
