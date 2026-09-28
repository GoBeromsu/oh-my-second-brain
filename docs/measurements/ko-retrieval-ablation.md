# Korean retrieval: bench and ablation

This record covers the Korean retrieval bench (`npm run bench`, `scripts/bench/`) and the first measurement it produced. The candidate is a Korean syllable-bigram lexical channel (BI) fused with the production lexical path (CUR). The record holds query ids, query types and aggregate numbers only. It contains no query text and no document paths.

It is a record, not a release gate. The CI check is `test/bench/tier1-lexical.test.ts`. It pins the per-type R@5 of CUR on the committed fixture and requires a keyword p50 under 300 ms.

## Outcome

The channel missed the merge gate, so it stays on a branch.

- **Tier 1.** CUR+BI raised overall R@5 from 0.848 to 0.970. Every gain came from the paraphrase type. No difference reached p < 0.05: overall R@5 p = 0.128, paraphrase R@5 p = 0.130.
- **Tier 3.** Not run yet. It needs the owner's private vault.
- **Merge rule.** The channel merges only when tier 3 holds or raises R@5 overall and per type, and the reinforced golden set gives R@5 p < 0.05. Both must hold.

Until then, the channel modules stay on the `feat/pr6-ko-bigram-channel` branch, unmerged. They do not exist on `main`:

- `lexical-ko.ts` under the engine's `retrieval/` directory: the bigram query builder.
- `bigram-index.ts` under the engine's `embed/` directory: the bigram index.
- `lexical-fusion.ts` under the engine's `retrieval/` directory: the CUR+BI fusion.

The bench infrastructure is what merges. The production lexical path is unchanged.

## Data sources

| Tier | Source | Status |
|---|---|---|
| 1 | `test/fixtures/ko-vault/` and its `queries.json`: 33 queries in 6 types, authored for this repository | Run (CI and local) |
| 2 | MIRACL-ko (`miracl/miracl`, `miracl/miracl-corpus` on Hugging Face) | **skipped (license unverified)** |
| 3 | The owner's private vault and query set, passed explicitly | Pending a user run |

**MIRACL-ko license verdict: unverified, so tier 2 is skipped.**

- The dataset cards for [miracl/miracl](https://huggingface.co/datasets/miracl/miracl) and [miracl/miracl-corpus](https://huggingface.co/datasets/miracl/miracl-corpus) declare Apache-2.0.
- The Korean passages are Wikipedia text, which upstream is CC BY-SA.
- The cards do not reconcile the two licenses, so downloading the corpus and deriving fixtures from it are not cleared.

`scripts/bench/miracl-download.mjs` refuses to run and exits 2. `npm run bench -- --tier 2` prints the same reason and exits 2. Enabling the download needs the owner's sign-off, and that sign-off is the code change that turns it on. The embedding candidate comparison (Qwen3-Embedding-0.6B, KURE-v1, BGE-M3) depends on tier 2, so it is skipped under the same condition.

## Channels

- **CUR.** The production lexical path is the dispatcher's `lex` sub-query over `engine_chunk_fts`.
  - `makeFtsQuery` prefix-matches whole whitespace tokens of two or more characters.
  - A particle-attached word, an infix of a compound, or a one-syllable query therefore does not match.
- **CUR+BI.** CUR is fused with the bigram channel by RRF with k = 60, the same constant the dispatcher uses. Each channel supplies 10 candidates.
  - **Index.** `engine_chunk_bigram` is a separate FTS5 table. It mirrors `engine_chunk_meta`, with Hangul runs expanded to overlapping syllable bigrams.
  - **Query.** A query becomes an OR of its exact bigrams. A one-syllable Hangul run becomes a prefix term. Non-Hangul terms are prefix terms, as in CUR.

## How it was measured

- Command: `npm run build && npm run bench -- --tier 1`. That is 10,000 permutations with seed 20260929.
- The runner copies the fixture vault into a temporary directory and removes `queries.json` from the copy. It then points `HOME`, `USERPROFILE`, `OMS_RUNTIME_ROOT`, `OMS_AUTO_UPDATE_STATE_DIR`, `OMS_{CLAUDE,CODEX,HERMES}_HOME` and `XDG_*` at temporary directories and unsets `OMS_VAULT`.
- It indexes lexically with no embedding, since `persist: false` builds a throwaway store. Each query runs once as a warm-up, then once timed.
- Metrics use binary relevance against `expected_files`. Repeated chunks of one note count once, at their best rank. Latency is the in-process retrieval call and excludes CLI startup. Percentiles are nearest-rank.
- Significance comes from a two-sided paired randomization (sign-flip) test on per-query scores with p = (count + 1) / (permutations + 1).
- Environment: Apple M1 Pro (10 cores), macOS 26.4.1 (Darwin 25.4.0), Node v24.21.0, 2026-09-29. The machine was busy, with a 1-minute load average of about 30 on 10 cores. At this load, sub-millisecond latency differences are noise.

## Tier 1 results: CUR vs CUR+BI

| Type | n | Channel | R@5 | MRR | nDCG@10 | p50 ms |
|---|---:|---|---:|---:|---:|---:|
| overall | 33 | CUR | 0.848 | 0.811 | 0.820 | 0.2 |
| overall | 33 | CUR+BI | 0.970 | 0.896 | 0.915 | 0.2 |
| alias | 6 | CUR | 1.000 | 0.917 | 0.938 | 0.1 |
| alias | 6 | CUR+BI | 1.000 | 0.917 | 0.938 | 0.2 |
| exact | 5 | CUR | 1.000 | 0.850 | 0.886 | 0.2 |
| exact | 5 | CUR+BI | 1.000 | 0.867 | 0.900 | 0.1 |
| hard_negative | 6 | CUR | 1.000 | 1.000 | 1.000 | 0.1 |
| hard_negative | 6 | CUR+BI | 1.000 | 1.000 | 1.000 | 0.4 |
| metadata | 5 | CUR | 1.000 | 1.000 | 1.000 | 0.2 |
| metadata | 5 | CUR+BI | 1.000 | 1.000 | 1.000 | 0.9 |
| mixed | 5 | CUR | 1.000 | 1.000 | 1.000 | 0.4 |
| mixed | 5 | CUR+BI | 1.000 | 1.000 | 1.000 | 0.2 |
| paraphrase | 6 | CUR | 0.167 | 0.167 | 0.167 | 0.3 |
| paraphrase | 6 | CUR+BI | 0.833 | 0.625 | 0.677 | 0.1 |

Paired randomization, CUR+BI minus CUR (10,000 permutations, seed 20260929):

| Type | ΔR@5 | p | ΔMRR | p | ΔnDCG@10 | p |
|---|---:|---:|---:|---:|---:|---:|
| overall | +0.121 | 0.128 | +0.086 | 0.154 | +0.095 | 0.096 |
| alias | 0.000 | 1.000 | 0.000 | 1.000 | 0.000 | 1.000 |
| exact | 0.000 | 1.000 | +0.017 | 1.000 | +0.014 | 1.000 |
| hard_negative | 0.000 | 1.000 | 0.000 | 1.000 | 0.000 | 1.000 |
| metadata | 0.000 | 1.000 | 0.000 | 1.000 | 0.000 | 1.000 |
| mixed | 0.000 | 1.000 | 0.000 | 1.000 | 0.000 | 1.000 |
| paraphrase | +0.667 | 0.130 | +0.458 | 0.185 | +0.510 | 0.130 |

How to read these results:

- **Where the gain comes from.** CUR+BI never lowers R@5 for any type, and every R@5 gain is in paraphrase: four more of its six queries reach the top 5. Those are queries whose wording differs from the note by particles or compound boundaries.
- **Why p stays above 0.05.** CUR misses R@5 on only five fixture queries, so at most five pairs can differ and the smallest exact two-sided sign-flip p is 2/32 = 0.0625. The observed four improved pairs give 2/16 = 0.125. No outcome on this set can reach p < 0.05.
- **What tier 1 can decide.** Tier 1 can show a regression. It cannot show significance. The merge decision belongs to tier 3.
- **Other types.** They are at or near ceiling on this fixture, so this set does not show whether BI changes them.

## Ablation: lexical → +vector → +HyDE → +rerank

| Stage | Tier 1 | Status |
|---|---|---|
| lexical (CUR) | R@5 0.848, MRR 0.811, nDCG@10 0.820, p50 0.2 ms | Run |
| lexical (CUR+BI) | R@5 0.970, MRR 0.896, nDCG@10 0.915, p50 0.2 ms | Run (branch-only channel) |
| +vector | – | Not run. It needs a configured embedding provider (`OMS_EMBEDDING_PROVIDER`, `OMS_EMBEDDING_MODEL`) and a model download. The bench runs in a sandboxed `HOME` with no provider, and ADR-005 forbids a silent lexical fallback. The candidate-model comparison also waits on tier 2. |
| +HyDE | – | Not run. It depends on the vector stage and needs a generation model. |
| +rerank | – | Not run. It depends on the vector stage and needs a reranker model. The hybrid p50 < 3 s check starts here. |

The per-type numbers for the lexical stages are in the tier 1 tables above.

## Tier 3: pending a user run

Tier 3 runs only against a vault passed explicitly. It never falls back to a default, the current directory, or a configured vault. Its report holds ids, types and aggregates only. It is written to the gitignored `bench-results/` and checked for privacy before it is written.

Run it on the channel branch, so the report includes CUR+BI:

```bash
git switch feat/pr6-ko-bigram-channel
npm run build
npm run bench -- --tier 3 --vault /absolute/path/to/vault --queries /absolute/path/to/queries.json
```

`--vault` and `--queries` can also be supplied as `OMS_BENCH_VAULT` and `OMS_BENCH_QUERIES`. The queries file uses the same schema as `test/fixtures/ko-vault/queries.json`. The merge rule reads the result as follows:

- **Pass.** Overall and per-type R@5 of CUR+BI stay at or above CUR, and the reinforced golden set gives R@5 p < 0.05. The reinforced set is the owner's private 34-query golden set (distinct from this 33-query fixture) plus at least 10 of the owner's own failed queries. Then the channel modules, the index version and the default-path wiring merge together, with a `CHANGELOG-kernel.md` entry.
- **Fail.** Otherwise, the channel stays branch-only.
