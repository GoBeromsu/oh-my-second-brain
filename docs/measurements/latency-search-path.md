# CLI latency: `oms search --path` against 0.18.3

This record compares the new engine-free exact read, `oms search --path`, with the 0.18.3 CLI. Both were measured in the same session on the same machine, back to back, as [latency-baseline-0.18.3.md](./latency-baseline-0.18.3.md) requires. It measures whole CLI invocations. It is not a release gate.

The PR build loads each command family only when it is dispatched, so this record also shows how that changes the startup cost every command pays.

## How it was measured

- **Baseline.** `origin/main` at `632e612b` (0.18.3), built in a separate worktree. It ran its own `scripts/bench/latency-baseline.mjs`, since 0.18.3 has no `--path`.
- **This change.** The PR build ran the same script with one added command:
  - `oms search --path 지식/낙상 위험 평가.md --vault <tmp>`
  - The request uses the NFC spelling of a note whose filename is NFD on disk, so the sample includes the normalization-insensitive lookup.
  - The lexical-receipt check still applies to `search query` only.
- **Order.** The two runs went back to back: 0.18.3 first, then the PR build.
- **Method.** N = 30 per mode. The cold/warm definitions, the isolated `HOME`/`XDG_*`/`OMS_*` directories and the nearest-rank percentiles are the same as in the baseline record.

## Environment

| Item | Value |
|---|---|
| Machine | Apple M1 Pro, 10 cores, 16 GiB |
| OS | macOS 26.4.1 (Darwin 25.4.0), arm64 |
| Node | v24.21.0 |
| Date | 2026-09-28 |
| Load | Busy: 1-minute load average fell from about 34 to about 23 on 10 cores across the runs |

## Results (ms, N = 30)

| Build | Command | Mode | p50 | p95 | min | max | mean |
|---|---|---|---|---|---|---|---|
| 0.18.3 | `note get` | cold | 505.8 | 913.0 | 339.7 | 1379.3 | 561.1 |
| 0.18.3 | `note get` | warm | 625.3 | 1299.0 | 285.6 | 1598.0 | 714.8 |
| 0.18.3 | `search query` (lexical) | cold | 549.2 | 1148.3 | 401.5 | 1367.4 | 640.0 |
| 0.18.3 | `search query` (lexical) | warm | 440.1 | 723.6 | 314.2 | 867.7 | 492.2 |
| PR | `note get` | cold | 178.4 | 315.9 | 118.0 | 417.2 | 205.3 |
| PR | `note get` | warm | 214.8 | 416.0 | 111.6 | 425.1 | 236.0 |
| PR | `search query` (lexical) | cold | 347.7 | 686.8 | 244.2 | 749.4 | 391.2 |
| PR | `search query` (lexical) | warm | 327.0 | 664.6 | 201.9 | 837.4 | 379.4 |
| PR | `search --path` | cold | 87.8 | 177.3 | 57.1 | 192.4 | 101.8 |
| PR | `search --path` | warm | 87.7 | 202.7 | 60.1 | 229.0 | 101.3 |

## Where the time goes

Separate probe, same session, right after the bench: 21 interleaved subprocess samples each, isolated home. The PR `search --path` row reads one note from a one-note vault.

| Invocation | 0.18.3 p50 | 0.18.3 min | PR p50 | PR min |
|---|---|---|---|---|
| `node -e 0` (bare Node startup) | 57 | 40 | 65 | 44 |
| `node` importing `dist/kernel/search/read-exact.js` | — | — | 84 | 51 |
| `node` importing `dist/cli/search.js` | 165 | 94 | 88 | 55 |
| `oms --version` (no command runs at all) | 410 | 254 | 90 | 52 |
| `oms search --path n/a.md` | — | — | 91 | 57 |

A load-hook trace of `oms search --path` on the PR build lists 12 modules and no package from `node_modules`:
- the entrypoint, argument parser, update notice and usage modules;
- `cli/search.js` with its argument and usage modules;
- `kernel/search/read-exact.js` and `kernel/text/nfc.js`.

The same trace on the build before lazy loading listed 88 modules, including `better-sqlite3` and `sqlite-vec`.

## Reading the numbers

- **The 150 ms p50 target is met.** `search --path` has a p50 of 88 ms cold and warm, and a p95 under 210 ms on a busy machine.
- **What changed.**
  - `src/cli/oms.ts` used to import every command module before it dispatched. That included the MCP server, the HTTP server, the host hooks, and the search engine with its native SQLite modules.
  - It now imports each command family inside its dispatch branch. `cli/search.ts` loads the engine session, the index command, vault link resolution and the morning-context module only on the branches that use them.
- **Startup is now close to bare Node.**
  - `oms --version` dropped from a p50 of 410 ms to 90 ms. That is about 25 ms over `node -e 0`.
  - `search --path` adds almost nothing on top of that: the exact read of one note is a few milliseconds.
- **Every command benefits.** `note get` and `search query` no longer load modules they do not use, so their p50s fell by roughly 300-400 ms and 100-200 ms. `search query` still opens the engine, so it stays in its own band.
- **The machine was busy.** Load was 23-34 on 10 cores. Read the min column and the startup probe for the floor, and treat small differences between p50s as noise.
