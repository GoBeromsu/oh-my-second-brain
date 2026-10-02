# Detached document transaction measurement

Date: 2026-10-02. Cloud Linux, Node 24.19.0, SQLite 3.53.1.

## Change and scope

A live lexical capture previously checked stored chunk hashes, changed its native
lexical rows, and published verified source evidence through separate store
transactions. The detached handle now groups that sequence in one synchronous
outer transaction. Existing nested transactions become savepoints. A failure
publishing source evidence rolls back that note's lexical changes.

Source reads and parsing happen before the transaction; spill/copy and final
source validation happen afterward. Persistent-store APIs, SQLite durability
settings, chunk contents/order, native ranking, memory budgets, and SDK timeouts
are unchanged. A SQL transaction is not atomic with an external Markdown save.

The measured control is local commit
`cddaa9fa4c03d3baa44728c2f8732bfd05c25afd` (the test-only #209 checkpoint), tree
`e9746d220e50bf42ac936afbf18e8cd24aa04917`. All 220 compiled runtime modules match
the preceding #208 build. The measured candidate is
`4320bdd266f7653318e075f5d8111cf38b59f630`, tree
`e4546c154221b98291f3574259f62b2c9418f306`. Later delivery changes add this
measurement document and clarify a source-read comment; executable statements
remain unchanged.

## Anonymous workload and method

The existing anonymous fixture contains 20,000 Markdown notes totaling
199,230,000 bytes. It varies line length, script, frontmatter size, malformed or
unclosed fences, scalar/list/date forms, aliases, and nested fields. It represents
scale and structural variety, not a measured private-vault distribution. The
fixture and standalone generator are documented in
[the cold lexical measurement](./cold-lexical-2026-10-02.md).

Three fresh CLI processes per build ran in the order control, candidate,
candidate, control, control, candidate. Each queried `coldneedle` with limit 10
and no persistent index. A coordinated CPU-quiet window excluded other known
rendering, builds, tests, and indexing. Operating-system file caches were not
dropped. Source/state byte comparison happened outside the CLI timer; it also
warms filesystem caches. The timer includes process startup and shutdown.

All six complete JSON responses were identical. Each run preserved the exact
vault/HOME/cache bytes and removed its private temporary database. Instrumentation
was limited to process-exit resource reporting; no per-function timers were used.

## Results

| Fresh CLI, no persistent index | Control | Candidate |
| --- | ---: | ---: |
| Median wall time | 28.877 s | 26.639 s |
| Wall-time range | 27.894–29.145 s | 25.939–27.280 s |
| Process maximum RSS range | 421.2–437.7 MiB | 421.4–429.5 MiB |

The median reduction is **7.75%** on this workload. The memory ranges overlap;
these results do not establish a general memory reduction or explain how much
time was spent in fsync. Private SQLite still needs temporary disk above its
retained-page budget. That budget is not a whole-process RSS cap.

A separate copied synthetic fixture held an explicitly built persistent lexical
index. One fresh seeded-cold pair took 25.385 s control and 23.894 s candidate,
with process maximum RSS about 731.3 MiB for each. Both responses and all
source/index byte comparisons matched. This single pair is a guardrail, not a
separate speedup claim. Unchanged chunks that still need source publication do
not gain a commit reduction and may incur additional savepoint work.

Three sequential warm engine queries per build, using limit 0 to omit previews,
took 2.036–2.191 s control and 1.999–2.159 s candidate. All six captured zero
note bodies and returned the same result as their cold preparation. These
overlapping ranges confirm retained-session behavior; they do not establish a
warm speedup or describe separate CLI invocations. The warm harness's maximum
RSS includes its cold bootstrap and byte-comparison guards, not just warm work.

## Correctness and limitations

Six new cases fail on the untouched control and pass on the candidate: source
publication failures after growing, replacing same-count, or emptying chunks
roll back both native lexical rows and source evidence, in memory and on disk.
Retries succeed, returned snapshots remain independent, and source/persistent
state and temporary cleanup remain checked. Independent review also injected
failure after source publication and exercised a copied handle after closing
the original.

A separate full-corpus verification found all 20,000 expected documents and 207
distributed sentinels. Native result hashes, folder facets, subject counts, and
exact subject/date selections matched the previous control evidence. Malformed
and unclosed notes remained lexical candidates; source/state bytes and private
temporary cleanup checks passed. This verification was not a timing run.

The affected suites passed 76 tests; independent review passed 55 overlapping
tests. The quiet aggregate run passed 3,609 tests with 12 skips and one known
baseline Unix-socket `listen EPERM` failure in this cloud sandbox. Lint, build,
documentation mapping, and production dependency audit passed; audit reported
zero vulnerabilities. Earlier logs retain a wrong default npm-cache setup and
MCP fixture deadline failures under concurrent load. The cache was corrected,
and the same unmodified MCP suite passed in the quiet aggregate run.

A complete native corpus is still constructed at first use. This result does
not establish that a user's vault meets a 60-second MCP deadline, certify an
installed host runtime, or make first search instantaneous. Actual-vault QA is
separate. No private note names, contents, field values, or measurements are
included here, and no deployment is part of the change.

## Reproduce

Build each selected checkout with its pinned dependencies, then run the existing
standalone anonymous generator in an isolated external work directory:

```sh
npm run build
node scripts/bench/cold-lexical-repro.mjs \
  --notes 20000 --bytes 199229440 \
  --work /absolute/external/scratch \
  --checkout /absolute/selected/checkout \
  --output /absolute/external/result.json
```

Run control and candidate sequentially in an agreed quiet window, alternating
their order. The retained comparison artifact also includes the shared-fixture
runner, seeded/warm guardrails, raw synthetic responses/resources, failure logs,
and source/cleanup assertions. These helpers are for anonymous synthetic data.
