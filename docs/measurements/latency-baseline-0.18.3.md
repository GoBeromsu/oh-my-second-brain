# CLI latency baseline: 0.18.3

This record is the latency reference for the built 0.18.3 CLI. Later changes are compared against it. It measures the whole CLI invocation, not ranking quality, so it is separate from the `boost-c040` and `model-default` measurement profiles described in [README.md](./README.md). It is not a release gate.

## How it was measured

Run `npm run build`, then `npm run bench:latency`. The script is `scripts/bench/latency-baseline.mjs`.

- **Samples.** Each sample is the wall-clock time of one `node dist/cli/oms.js ...` subprocess. That includes Node startup, module loading and vault resolution. N = 30 per mode. Set N with `--n <runs>` or `OMS_BENCH_N`.
- **Vault.** A temporary copy of the synthetic Korean fixture `test/fixtures/ko-vault/` (30 notes plus a README). One filename is converted to NFD when the copy is made.
- **Isolation.** Every subprocess runs with `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `OMS_RUNTIME_ROOT`, `OMS_AUTO_UPDATE_STATE_DIR`, `OMS_CLAUDE_HOME`, `OMS_CODEX_HOME` and `OMS_HERMES_HOME` pointed at a fresh temp directory, with `OMS_VAULT` unset. No real vault is touched, and neither is `~/.oms`.
- **Cold.** Fresh OMS state (vault copy + home) for every sample. The OS file cache and the Node binary are not reset, so cold does not mean a cold machine.
- **Warm.** One vault copy and one home are reused. One warm-up run is discarded, then 30 samples run back to back.
- **Percentiles.** Nearest-rank.
- **Commands.**
  - `oms note get Resources/낙상판정기준.md --vault <tmp>`
  - `oms search query 낙상판정기준 --vault <tmp>`. This is a plain query, so it expands to lexical only. The script checks that every receipt reports `usedChannels: ["lex"]` and fails if one does not.

## Environment

| Item | Value |
|---|---|
| OMS | 0.18.3 (`dist/` built from `origin/main` at 0.18.3) |
| Machine | Apple M1 Pro, 10 cores, 16 GiB |
| OS | macOS 26.4.1 (Darwin 25.4.0), arm64 |
| Node | v24.21.0 |
| Date | 2026-09-28 |

## Results (ms, N = 30)

| Command | Mode | p50 | p95 | min | max | mean |
|---|---|---|---|---|---|---|
| `note get` | cold | 407.7 | 843.5 | 255.1 | 938.6 | 471.1 |
| `note get` | warm | 427.1 | 917.0 | 295.1 | 942.7 | 514.5 |
| `search query` (lexical) | cold | 724.4 | 1259.9 | 436.6 | 1310.9 | 790.0 |
| `search query` (lexical) | warm | 554.4 | 1049.1 | 345.5 | 1732.6 | 654.9 |

## Reading the numbers

- **Do not compare other runs against this table.** These numbers were taken on a busy machine. When PR2 reports its latency, it must re-measure 0.18.3 and PR2 in the same session, on the same machine, with `npm run bench:latency`, and compare those two runs.

- **The machine was busy.** Other development processes were running during this run, which is why the spread is wide: p95 is about twice p50. The warm `note get` p50 is no better than cold, so cold and warm are within noise for `note get`. An N = 3 smoke run shortly before gave a warm p50 of about 300–400 ms for both commands. Compare future runs on a quiet machine, and read the p50 more than the p95.
- **Process startup dominates.** Even the smallest `note get` sample costs about 250 ms. A single-note read is mostly paying for Node startup and CLI module loading, not vault I/O.
- **Lexical search costs more than `note get`.** It builds an in-memory ephemeral core because no engine store exists. In this run the gap is about 150–300 ms at p50.
