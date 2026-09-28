# CLI latency: `oms search --path` against 0.18.3

This record compares the new engine-free exact read, `oms search --path`, with the 0.18.3 CLI. Both were measured in the same session on the same machine, back to back, as [latency-baseline-0.18.3.md](./latency-baseline-0.18.3.md) requires. It measures whole CLI invocations. It is not a release gate.

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
| Load | Busy: 1-minute load average about 28 on 10 cores during the runs |

## Results (ms, N = 30)

| Build | Command | Mode | p50 | p95 | min | max | mean |
|---|---|---|---|---|---|---|---|
| 0.18.3 | `note get` | cold | 377.3 | 630.4 | 237.1 | 1333.3 | 423.4 |
| 0.18.3 | `note get` | warm | 385.0 | 646.9 | 245.1 | 814.0 | 409.4 |
| 0.18.3 | `search query` (lexical) | cold | 468.7 | 874.4 | 341.8 | 1635.5 | 542.3 |
| 0.18.3 | `search query` (lexical) | warm | 458.3 | 930.9 | 306.7 | 1307.0 | 540.6 |
| PR | `note get` | cold | 370.5 | 531.9 | 250.3 | 551.9 | 390.3 |
| PR | `note get` | warm | 254.4 | 393.4 | 212.1 | 416.0 | 264.3 |
| PR | `search query` (lexical) | cold | 541.2 | 978.3 | 323.6 | 1316.2 | 578.1 |
| PR | `search query` (lexical) | warm | 434.6 | 798.5 | 289.6 | 864.8 | 488.5 |
| PR | `search --path` | cold | 346.6 | 793.8 | 223.8 | 899.5 | 397.9 |
| PR | `search --path` | warm | 587.5 | 923.4 | 329.0 | 1017.4 | 637.8 |

## Where the time goes

Separate probe, same session: 21 interleaved subprocess samples each, isolated home.

| Invocation | p50 | min |
|---|---|---|
| `node -e 0` (bare Node startup) | 58 | 40 |
| `node` importing `dist/kernel/search/read-exact.js` | 72 | 52 |
| `node` importing `dist/cli/search.js` | 162 | 100 |
| `oms --version` (no command runs at all) | 425 | 265 |

## Reading the numbers

- **The 150 ms p50 target is not met.**
  - `search --path` has a cold p50 of 347 ms and a warm p50 of 588 ms.
  - Its fastest sample (224 ms) is already over the target.
- **The read is not the cause.**
  - readExact and its imports add about 14 ms over bare Node startup.
  - The directory walk and file read for one note are a few more.
- **The cost is CLI startup.**
  - `src/cli/oms.ts` statically imports every command module before it dispatches. That includes the MCP server, the HTTP server, the host hooks, and the search and engine modules.
  - As a result, `oms --version` alone has a p50 of 425 ms and a minimum of 265 ms on this machine. Every command, `search --path` included, pays that before running.
  - Meeting the target needs lazy, per-command loading in the entrypoint. That is a separate change from this PR.
- **The machine was busy.** Load was about 28 on 10 cores during the runs.
  - The ordering inside the PR run is noise, not signal. For example, warm `search --path` came out slower than cold, and warm `note get` came out faster than the 0.18.3 warm run.
  - Read the min column and the startup probe for the floor, not the differences between p50s.
  - Within that noise, `search --path` is in the same band as `note get`. It is not in the `search query` band, because it opens no engine store and builds no ephemeral core.
