# Automatic maintenance: cloud characterization

This describes the optional implementation, not a deployed host or a real-vault performance claim. Maintenance remains off unless an MCP/HTTP invocation explicitly selects it. Read-only calls do not initialize a persistent index or start maintenance.

## Reproduce the bounded updater workload

After installing the existing dependencies and building, run:

```sh
npm run build
node scripts/bench/maintenance-repro.mjs --notes 20000 --work-dir /path/to/external/scratch --output /path/to/result.json
```

The helper creates and removes its own anonymous fixture. The scratch parent must be outside every real vault. It creates 20,000 notes with 22 frontmatter fields each, totaling 22,129,994 bytes, and explicitly initializes a lexical index. No model, external API, private note, or host configuration is used.

Three consecutive runs used cloud Linux, Node 24.19.0 and SQLite 3.53.1 on 2026-10-02. Rendering was paused; other known build, embedding and indexing tasks were idle. This is a small repeated characterization, not a statistical capacity guarantee.

| Existing-index controller phase | Median | Range | Markdown body captures in every run |
| --- | ---: | ---: | ---: |
| Startup reconciliation | 0.859 s | 0.812–1.015 s | 0 |
| Unchanged full reconciliation | 0.844 s | 0.809–1.030 s | 0 |
| 100 edited notes | 0.631 s | 0.572–0.668 s | 100 |
| 1,000 edited notes | 5.689 s | 5.446–6.371 s | 1,000 |
| 100 renames and 100 deletions | 2.301 s | 2.259–2.392 s | 100 |

Each result includes controller flush only: fixture edits, verification reads, OS watch delivery, debounce, search latency and embedding inference are excluded. The helper injects deterministic watch hints and awaits the production controller. Separate lifecycle tests exercise real MCP processes and filesystem watching. Zero body captures depend on usable filesystem witnesses; weak evidence still falls back to bytes.

Initial lexical index setup took 24.59–24.65 s. Whole-process peak RSS was 263.4–266.0 MiB, including setup and validation. The final persistent index was about 63.3 MiB, separately from 21.1 MiB of Markdown and transient WAL/SHM files. These sizes are observations, not upper bounds or a statement about native model memory. Private search spill requirements are separate from this updater fixture.

Every run checked exact FTS membership, final source inventory (19,900 notes), unchanged authored source bytes, and empty ownership directories after shutdown. The fixture was removed on completion. The body-read assertions are more deterministic than the wall-clock samples.

## Warm private lexical corpus

The related warm-corpus change was measured with three alternating baseline/candidate pairs on a separate anonymous 20,000-note fixture. Validated query time included preparation plus final source validation. Result hashes matched and persistent database images remained unchanged. Candidate sessions seeded once, then performed no reseed after persistent index maintenance.

Median validated queries after unchanged vector synchronization were 2.060 → 1.605 s; after 100 persisted edits, 2.087 → 1.713 s; after 1,000 edits, 2.398 → 2.356 s with overlapping ranges. Ordinary warm queries were 1.572 → 1.707 s and cold queries 9.114 → 9.736 s, also with overlapping ranges. These data support avoiding a particular reseed, not a universal latency improvement. The fixture used deterministic four-dimensional test vectors and did not measure real-model inference. Retained native pages were 61.6–63.4 MiB; that metric is not process RSS.

## Operational limits and validation scope

- MCP/HTTP can reuse a private lexical session. A new CLI process pays cold startup; these warm numbers do not certify a CLI fallback workflow.
- Unchanged maintenance still enumerates and stats the corpus. Large edit bursts take time, and raw frontmatter remains part of the embedding input, so full mode can have a vector backlog after metadata changes.
- Ownership is cooperative within one host and PID namespace. A paused live owner blocks takeover. All concurrent writers must use the upgraded protocol; manual lock deletion and mixed-version recovery are outside its guarantee.
- SQLite transactions do not make Markdown saves atomic. Source checks reject observed races, and startup/periodic reconciliation repairs interrupted source-to-index updates. Partial scans never authorize mass deletion.
- Cloud tests cover revision races, late embeddings, replacement schemas, cancellation, unknown/corrupt ownership, busy writers, watch loss/overflow, rename/delete/recreate, restored mtime, cold read-only startup, two MCP processes, EOF and bounded HTTP shutdown. Full-mode tests use deterministic providers; installed native loading is checked for a no-download/no-build policy.
- This followup did not run native model inference or validate the user's installed Hermes ABI, filesystem, permissions, or host deployment. Those remain separate real-use checks. The pre-existing cloud Unix-socket test restriction is reported separately from product regressions in aggregate evidence.
