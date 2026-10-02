# Cold lexical search: repeated-work reduction

On one anonymous 20,000-note / 199,230,000-byte fixture, the two changes reduce median fresh-process, no-index CLI search from **56.130 s to 29.011 s (48.3%)**. This is still a full-corpus bootstrap. It is not an instant-search guarantee or a result measured on a private vault or installed Hermes host.

## Workload and method

The fixture varies frontmatter independently from body structure: absent, malformed and unclosed metadata; 4/12/28/60-key maps; scalars/lists, aliases, nested values, date-looking strings, explicit timestamps and Unicode. Five body groups have 36/110/700/3000-character Latin lines and 80-character CJK lines. It represents scale and structural variety, not a measured distribution of the user's vault.

Control is source commit `854bee108b0dd2cf6985df865c5c77e46fe15041` (published #205 tree `95783f556443b607f0d0460cb581aeba6e6295a9`). A is `ad5840d900b750ffb1410c42a7873cc9c43d0b09`, incremental token accounting. B is `c8ee601e151c32cc74f8cd42b03d25b123f6a94f`, A plus shared canonical frontmatter parsing. The publication stack places these unchanged runtime diffs after the separate npm 12 packaging fix; that base change touches no runtime source.

Three fresh processes per build ran on the same cloud Linux machine with Node 24.19.0, in the order control/A/B, B/control/A, A/B/control. Other known render/build/indexing work was paused. Every process ran `oms search coldneedle --vault <same-fixture> --limit 10`, with no persistent index or warm session. OS page caches were not dropped; byte validation warmed them. Fixture generation and byte verification were outside the CLI timer. A lightweight exit hook recorded process resources, without per-function profiling wrappers.

| Build | Median wall time | Range | Peak RSS range |
| --- | ---: | ---: | ---: |
| Control | 56.130 s | 56.006–56.194 s | 425.1–433.7 MiB |
| A | 33.787 s | 33.491–33.808 s | 432.9–451.4 MiB |
| B | 29.011 s | 27.971–29.096 s | 427.8–430.5 MiB |

A reduces median time by 39.8%; B removes another 14.1% relative to A. A's process-memory observations were higher; B's range overlaps control. These small samples are not statistical bounds. Existing retained SQLite/projection budgets remain unchanged.

## Why these changes

A separate instrumented baseline took 58.954 s versus 55.061 s uninstrumented, a 7.1% perturbation. Its chunker used 31.158 s, including 4.709 s for title extraction; projection parsing used 6.723 s, including 5.410 s YAML. Token accounting revisited 3.120 billion characters in 2.036 million calls because it rescanned the growing buffer after every line. Native writes/checks took 10.962 s; spill copying took 0.165 s; initial/final source scans took about 1.0/1.1 s. Nested and overlapping stage times must not be added indiscriminately.

The first change accounts for each line once, preserving integer quarter-token weights and exact overlap separators. The second shares the canonical parse of the same captured bytes between compact metadata projection and title extraction. Raw frontmatter remains in chunk/embedding input. Neither change alters ranking, eligibility, freshness validation, storage durability, memory budgets, SDK timeouts or persistent-index policy.

## Correctness and limits

All nine complete CLI responses matched, including hits/order, snippets, scores, facets and receipts. Full-corpus validation recalled 20,000/20,000 paths and 207 distributed sentinels, including malformed/unclosed notes. Facet counts and exact selections matched. Both candidates produced the same 74,666 complete chunks for all 20,000 notes: text, title, heading path, ordinal and digest all matched control. The aggregate chunk-output SHA-256 was `c06e2b9034aa1013cd0cf2191e27c543c4f2b322cc5453af2b360a17f45c8a7c`.

Vault, isolated HOME and cache bytes remained unchanged; temporary session files were cleaned. The baseline ordinary query sampled about 712 MiB of temporary disk. These optimizations do not target disk footprint. A separate multi-query full-corpus/observed verification peaked around 821 MiB RSS for B (baseline 824 MiB), distinct from ordinary cold-search memory above. Filesystem/temp capacity and installed native-module readiness remain prerequisites.

The first cold query still reads and indexes the complete corpus privately before answering. A retained MCP/HTTP session can reuse it; a fresh CLI process pays startup again. Actual-vault latency and host-agent integration must be tested separately. No persistent index is created by this search, no background writer is started, and no prewarming or timeout increase is included.

## Small independent reproduction

Build the selected checkout, then use an external scratch directory:

```sh
npm run build
node scripts/bench/cold-lexical-repro.mjs --notes 20000 --bytes 199229440 --work /path/to/external/scratch --checkout /path/to/built/checkout --output /path/to/result.json
```

The helper creates only its own anonymous fixture, launches a fresh CLI process, checks the sentinel result and source/state preservation, records wall/CPU/RSS, and removes its fixture. Its default matches the measured corpus recipe. Use quiet alternating runs for comparisons; the smaller `--notes 200 --bytes 1992294` case is a functional smoke, not the 20k measurement. Detailed original profiling and differential helpers/results are retained in the delivery artifact.
