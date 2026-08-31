# Measurement evidence

Production-seam measurement records are human-input artifacts. The harness never
invents relevance or provenance labels, and a release must never use a
synthetic manifest.

## Profiles and the release path

The shipped ranking default is the released v0.3.0 `boost-additive` baseline:
after RRF, its score is `hit.score + boost` and it does not reorder individual
lists. `boost-k-scale`, `boost-per-list`, and `boost-zero` are frozen C040
experiment arms, not the current default.

`boost-c040` applies only when a release changes the shipped ranking default
away from that baseline. For that release, its one manifest path is
`docs/measurements/boost-c040.json`; CI and `npm run release:check` must
validate that exact path. Do not substitute a run-specific filename or a
fixture manifest. A release that ships `boost-additive` passes this gate with a
receipt and needs no manifest. The `model-default` profile is a separate,
model-evidence check and is not a replacement for a required `boost-c040`
gate.

Provide these inputs for a real-vault `boost-c040` three-arm run:

- `OMS_GOLDEN_QUERIES`: curated query JSON.
- `OMS_GOLDEN_QRELS`: independently curated qrels JSON.
- `OMS_GOLDEN_PROVENANCE`: JSON object mapping each retrieved repository-relative document path to `authored`, `curated`, or `external-raw`.
- `OMS_MEASUREMENT_DATASET_ID` and `OMS_MEASUREMENT_HARNESS_COMMIT`.
- `OMS_MEASUREMENT_MANIFEST_OUTPUT=docs/measurements/boost-c040.json`.

The destination is create-only: an existing manifest is rejected. The emitted
manifest binds qrels, all three production arms, paired raw evidence, verdict,
and its raw-evidence SHA-256. The three preregistered arm IDs are
`boost-k-scale`, `boost-per-list`, and `boost-zero`; they must all be present.

## Required validation when changing the ranking default

The release gate selects the profile explicitly and validates the exact
manifest path:

```bash
OMS_MEASUREMENT_REQUIRED=1 \
OMS_MEASUREMENT_ATTESTATION_REQUIRED=1 \
OMS_MEASUREMENT_RELEASE=1 \
OMS_MEASUREMENT_PROFILE=boost-c040 \
OMS_MEASUREMENT_MANIFEST=docs/measurements/boost-c040.json \
OMS_PREREG_QRELS_HASH=sha256:<preregistered-qrels-digest> \
OMS_MEASUREMENT_TRUSTED_PUBLIC_KEY='<trusted-ed25519-public-key>' \
npm run check:measurement
```

Adopting any experiment arm as the shipped default requires this real-vault,
signed manifest. There is no waiver for `boost-c040`.

`OMS_PREREG_QRELS_HASH` (or `OMS_PREREG_QRELS`) is external preregistration
evidence; a self-declared `qrelsHash` in the manifest is not sufficient for a
required check. The trusted key is supplied through
`OMS_MEASUREMENT_TRUSTED_PUBLIC_KEY` (the CI secret), and the manifest
attestation must use that exact Ed25519 public key, a valid signature, and the
validator's immutable-payload digest. Required release checks also require
paired raw evidence for every arm. Missing qrels evidence, trusted key,
attestation, or paired raw evidence fails closed.

For the separate model-default profile, invoke the checker directly with its
own evidence manifest:

```bash
OMS_MEASUREMENT_REQUIRED=1 \
OMS_MEASUREMENT_PROFILE=model-default \
OMS_MEASUREMENT_MANIFEST=/path/to/model-default.json \
node scripts/check-measurement-manifest.mjs
```

That profile requires provider/model/SHA-256 setup evidence (or its explicitly
approved, time-bounded no-default waiver). It does not waive the `boost-c040`
release gate.

## Parity profiles (qmd comparison)

The parity profiles are a third, separate contract. They do not gate the shipped
ranking default and they do not substitute for `boost-c040`; they decide whether
OMS retrieval measures up to a pinned qmd baseline over a real vault.

| Artifact | Role |
|---|---|
| [`docs/preregistration/parity-b1.md`](../preregistration/parity-b1.md) | Freezes the B1 procedure and thresholds before any run exists |
| [`docs/preregistration/parity-b2.md`](../preregistration/parity-b2.md) | Freezes the B2 procedure, the only profile that may authorise a replacement claim |
| [`qmd-parity-matrix.md`](./qmd-parity-matrix.md) | Pins the comparator baseline and inventories its capability surface |
| `test/golden-set/parity-gate.ts` | The frozen relevance and operability bounds, as constants |
| `test/golden-set/parity-preregistration.ts` | Admissibility of a declared run, checked before scoring |
| `test/golden-set/parity-corpus.ts` | Order-independent corpus digest, so a changed vault invalidates a run |
| `test/golden-set/parity-operability.ts` | Peak RSS, embed wall time, and query p95 measurement |
| `test/golden-set/parity-stop-policy.ts` | What a miss denies: B2 start, release, and any replacement claim |
| `test/golden-set/parity-preflight.ts` | Whether a run can happen at all, and who must unblock it |
| `test/golden-set/parity-outcome.ts` | One audited record joining admissibility, observed digests, relevance, operability, B1→B2 admission, and release/claim enforcement |
| `test/golden-set/parity-comparator.ts` | Direct exact-checkout qmd arm, raw paired rows, per-modality/aggregate metrics, and query/qrels/result digest binding |
| `test/golden-set/parity-oms-run.ts` | OMS sync/count/vector/RSS/wall-time/plain/precision-p95 evidence generated by the same engine run used for relevance |

Thresholds live in code as constants rather than configuration, and the gate
refuses to run when an environment variable tries to move one — including the
R2 harness's own `OMS_GOLDEN_MIN_RECALL`. A bound that can be edited after seeing
results is not a bound.

Check readiness before spending a run:

```bash
OMS_VAULT=/path/to/vault npx vitest run test/golden-set/parity-run.test.ts
```

The runner prints a preflight report naming every unmet precondition and whether
it is implementation work or the vault owner's to supply. With the complete
paired environment it verifies and prepares the pinned qmd index, measures OMS,
persists the sealed raw record, emits the audited outcome, and enforces release
and replacement stop policy. Without those variables it emits only the
diagnostic OMS harness report, explicitly not a parity verdict.

The exact comparator is installed and verified. Two inputs remain the owner's:

- **The frozen query set and curated qrels must be authored by the vault owner.**
  Relevance is a judgement about that person's own notes. The harness already
  refuses inferred provenance, and fabricated labels would produce a number with
  no meaning.
- **The approved corpus must be available.** The objective names the historical
  20,959-file snapshot, while the live vault has changed. The owner must provide
  that snapshot or authorize a new preregistration after edits stop.

On any miss the policy is stop-and-report: preserve the raw evidence, change no
threshold, qrels file, or retrieval setting, and open a separately reviewed
retrieval-correction plan.

## Winner selection

All three arms are measured before selection. The manifest must declare a
`winnerArmId`; it may be `boost-k-scale` or `boost-per-list`, but never the
`boost-zero` ablation. Any `verdict.winnerArmId`/`verdict.winner` alias must
agree with that declaration. The checker calculates C040 for the declared
candidate against `boost-zero`, never trusting a hard-coded arm name or a
claimed `verdict`. C040 requires every primary-class nDCG@10 delta to be at
least `+0.05`, every other class delta to be at least `-0.02`, candidate p95 to
be no more than `1.5x` baseline p95, and the paired bootstrap CI lower bound
to be strictly greater than zero. A release is selected only when the
calculated result passes; otherwise there is no winner.
