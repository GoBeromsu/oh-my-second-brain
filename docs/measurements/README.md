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
