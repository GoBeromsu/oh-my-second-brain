# Preregistration — B1 foundation parity profile

> **Standing.** This document freezes the *procedure and thresholds* of the B1
> parity comparison before any result exists. It does not contain a measurement,
> and it makes no claim about whether OMS retrieves as well as qmd. The two
> inputs that decide the verdict — the query set and its relevance labels — are
> deliberately **not** written here, because they are the vault owner's judgement
> and an agent inventing them would make the whole exercise circular.

## Why this exists before the run

A threshold chosen after seeing results is not a threshold, it is a rationalisation.
The B1 gate therefore fixes every number in code as a constant
(`test/golden-set/parity-gate.ts`) rather than as configuration, and the harness
refuses to run when an environment variable tries to move one
(`FORBIDDEN_THRESHOLD_OVERRIDES`, which includes the pre-existing
`OMS_GOLDEN_MIN_RECALL` escape hatch). Admissibility of a declared run is checked
separately in `test/golden-set/parity-preregistration.ts`, before scoring, so a
run against the wrong comparator is rejected outright instead of being scored and
then argued about.

## Comparator baseline

| Field | Value |
|---|---|
| Repository | `https://github.com/tobi/qmd` |
| Version | `2.8.3` |
| Commit | `facd35e01359e59d938bc9418e93fb9318addee3` |

Capability surface at that commit is inventoried in
[`docs/measurements/qmd-parity-matrix.md`](../measurements/qmd-parity-matrix.md).

Changing this commit invalidates every prior run and requires a new
preregistration. The admissibility check matches it exactly rather than by version
range, because a different build is a different comparator.

## Scope of the B1 profile

B1 scores **lexical** and **vector** retrieval only. qmd's own query expansion is
disabled for these arms so the two systems are compared like for like. OMS
expansion did not exist when this procedure was frozen; its later implementation
does not broaden B1. The explicit generated strategy enters only at the separate
`b2-parity` profile, and `parity-outcome.ts` refuses that profile until this gate
passes.

## Frozen thresholds

Relevance, per modality (`lex`, `vec`):

| Metric | Floor |
|---|---:|
| recall@10 | 0.80 |
| nDCG@10 | 0.70 |
| MRR@10 | 0.65 |

Relevance, aggregate:

| Metric | Floor |
|---|---:|
| recall@10 | 0.85 |
| nDCG@10 | 0.75 |
| MRR@10 | 0.70 |

Against the matching qmd arm, OMS may trail by at most **0.02** on any metric.
The allowance is not zero because a demand to win everywhere would fail on noise
alone; it is small because the claim at stake is parity, not proximity.

Every modality needs at least **five** curated rows and must cover both Korean and
English/mixed queries. A vault that is substantially Korean cannot be certified by
an English-only query set.

Operability, enforced independently:

| Property | Bound |
|---|---:|
| exit code | 0 |
| reported file errors | 0 |
| stored vectors | equal to expected embeddable chunk count |
| peak RSS | ≤ 8 GiB |
| embed wall time | ≤ 6 h |
| p95 plain query | ≤ 5 s |
| p95 precision query | ≤ 30 s |

Operability and relevance cannot satisfy each other. A run that finishes fast,
within memory, and returns irrelevant documents fails; so does an excellent
ranking that could not complete. This is asserted directly in
`parity-gate.test.ts` under `gate separation`.

## Declared inputs a run must freeze

`evaluateAdmissibility` requires all of the following before any score counts:
corpus digest and exact file count, query-set digest, qrels digest, query count, candidate limit,
result depth `k`, RRF constant, rerank and expansion flags, embedding model
identity with its immutable revision and prompt scheme, host description,
and bootstrap seed. Ranked outputs and timings do not exist before execution and
therefore are not preregistered. The runner seals the complete observed raw
record after execution, stores that SHA-256 in the audited outcome, and rejects
any later mutation when the seal is verified.
The settings freeze each enabled model's artifact SHA-256 and exact qmd model
URI. B1 requires embedding identity; B2 additionally requires rerank and
generation model/revision/checksum plus the generation prompt scheme. The runner
verifies OMS's installed receipts and qmd's resolved cache bytes share those
checksums before either arm can count, then verifies them again after execution.
Queries and qrels must be distinct artifacts, compared after digest normalisation
so `sha256:AB…` and `ab…` cannot disguise reuse of one file as both.

Metric depth may not exceed the candidate pool. Scoring at `k=50` over 40
candidates would measure truncation rather than ranking.

## Blocking preconditions

The exact pinned comparator is installed and verified separately from the stale
global `qmd 2.1.0` command. The remaining inputs are owner evidence:

1. **The query set and curated qrels must be authored by the vault owner.**
   Relevance is a judgement about that person's own notes. Fabricating or
   inferring labels would produce a number with no meaning, and the completion
   contract forbids it. Supply them through the harness's existing
   `OMS_GOLDEN_QUERIES` / `OMS_GOLDEN_QRELS` injection together with their
   preregistered digests.
2. **The frozen corpus must exist.** The approved run names the historical
   20,959-file snapshot. The live vault has changed, so the owner must provide
   that snapshot or explicitly authorize a new preregistration after edits stop.

## Failure policy

A miss on any relevance or operability bound is a **stop-and-report**, not an
invitation to retune. Preserve the raw evidence, record which arms and metrics
failed, and do not begin or roll out B2, publish a release, or describe OMS as a
qmd replacement. Correcting retrieval is a separately reviewed objective; the
4096 sqlite-vec knn clamp may be *identified* as a cause here but is not changed
under this plan.
