# Model-default E-1 decision record

> **E-1 decision made: option 2, the preregistered Rule 1 fallback.** Recorded
> 2026-08-27 by the vault owner when authorising this release. This record is
> not a model selection and grants no waiver of any other gate.

## Decision

No real-vault `model-default` measurement exists, so the E-1 escalation
condition was met and the product decision fell to the vault owner. The two
available options were:

1. Hold the release until the measurement exists.
2. Invoke the preregistered Rule 1 fallback.

There was no third option; choosing a different model is a contract change that
requires replanning, not a fallback.

The owner chose option 2 and authorised the release. Rule 1 applies verbatim:
this release introduces no new default embedding model, default-model
acquisition moves to a later release, and explicit configuration behaviour is
unchanged.

## What is true regardless of the decision

This tree introduces no new default embedding model. Explicit
`OMS_EMBEDDING_PROVIDER` plus `OMS_EMBEDDING_MODEL` behaviour is unchanged.
`oms setup --embedding-descriptor <path>` accepts an operator-supplied
descriptor with SHA-256 verification.

The machine-verified no-default contract is implemented and fails closed: it
verifies at runtime that no default descriptor pointer is introduced, that the
explicit environment pair resolves identically with and without the fallback
active while a half pair still fails loudly naming both variables, and that the
fallback and MCP paths perform zero downloads.

This release does not consume a `model-default` waiver record. The required
measurement gate runs the `boost-c040` profile, which the shipped ranking
baseline satisfies without a manifest, so no waiver is presented or accepted.

## Separate required measurement

The `boost-c040` profile remains required and is never waivable. Boost
measurement and model measurement are different measurements; a
`model-default` decision does not replace or waive `boost-c040`.

## Closing condition

The deferral closes only when a validator-accepted, green `model-default`
manifest exists and was produced from a real vault by that vault's owner.

---

# Explicit-acquisition decision record (v0.8.0)

> **Decision: ship an explicit, opt-in acquisition command; do not ship an
> implicit or automatic default.** Recorded 2026-08-30 by the vault owner when
> authorising v0.8.0. This record does **not** close the deferral above, does
> not select a default model for any unconfigured vault, and consumes no
> waiver.

## What was decided

v0.8.0 adds `oms setup --embedding-default`, which acquires a pinned
EmbeddingGemma-300M descriptor, verifies the downloaded bytes against a pinned
SHA-256, and publishes it as the installed default for that machine.

The owner was presented with the tension against the deferral above and chose
the explicit-install path over both waiting for a real-vault `model-default`
measurement and shipping an automatic first-run download.

## Why this is not the capability the deferral withheld

Rule 1's substance is that a release "introduces no new default embedding
model" and leaves "explicit configuration behaviour unchanged". Both hold:

- No unconfigured vault gains a default. With no environment pair and an empty
  cache, `resolveEmbeddingModel` still returns `available: false`,
  `source: "none"`. The pinned constant is unreachable from resolution; its only
  production consumer is the explicit setup branch.
- The machine-verified no-default contract still passes unchanged, including its
  zero-download assertion over the MCP surface.
- Explicit `OMS_EMBEDDING_PROVIDER` + `OMS_EMBEDDING_MODEL` behaviour is
  untouched, and a half pair still fails loudly naming both variables.

The user names the model by running a command; the runtime never chooses one.
That is the distinction this record turns on.

## What remains unproven

No real-vault `model-default` measurement exists for this model. Its retrieval
quality is therefore asserted on the basis that it is the same model and prompt
format the reference toolchain (qmd) uses by default, not on a measured
comparison against an alternative in this project's own harness. Anyone
selecting it is adopting that unmeasured assertion.

`boost-c040` is unaffected and remains required and never waivable.

## Closing condition (unchanged)

The deferral above still closes only on a validator-accepted, green
`model-default` manifest produced from a real vault by that vault's owner.
Until then, automatic or implicit default-model acquisition stays withheld.

## What enforces this, and what does not

Nothing automated asks for the `model-default` manifest. `npm run
check:measurement` runs the `boost-c040` profile only and no workflow requests
another, so no build objects while an installable default ships.

That is deliberate rather than an oversight to fix in code, because the manifest
cannot presently be produced at all. The validator can check one:
`scripts/check-measurement-manifest.mjs` lists `model-default` in
`MEASUREMENT_PROFILES` and, in strict mode, demands a complete descriptor,
`armId: "model-default"`, paired raw evidence with an A-embed `kind` and
`outputDigest`, a green verdict, and a timestamp. Nothing emits one:

- **No A-embed arm exists.** The validator reads `aEmbedMetrics`, but
  `test/golden-set/harness.ts` knows only the three boost arms
  (`boost-k-scale`, `boost-per-list`, `boost-zero`).
- **No preregistered protocol defines the measurement.** `docs/preregistration/`
  holds `boost-arms.md` and nothing for `model-default`: no query classes, no
  comparison, no pass rule.
- **No manifest producer exists for any profile.** `boost-c040` never needed
  one, because the shipped ranking default is the released baseline and that
  gate passes with a receipt.

So "produce the measurement" means: preregister a protocol, add the arm, add a
producer, then run it against a real vault with curated labels. The first step
must not be written by an agent, and deliberately was not. Preregistration is
the commitment device that stops the metric being chosen after the fact, so
whoever defines it must do so before knowing how EmbeddingGemma-300M scores
under it.

One narrower invariant *is* enforced, by
`test/architecture/model-default-disclosure.test.ts`: while an installable
default ships, this document must keep stating that the model is unmeasured, and
the unconfigured-vault guidance must name `--embedding-default` exactly when that
flag is wired. Withdrawing the default lifts both requirements, so a genuine
removal is not obstructed. The gate holds the disclosure, not the measurement.

---

# Unmeasured-state acceptance (v0.8.3)

> **Decision: accept the unmeasured state on the record and keep shipping the
> installable default.** Recorded 2026-08-30 by the vault owner, resolving
> [#78](https://github.com/GoBeromsu/oh-my-second-brain/issues/78). The two
> alternatives were declined: committing to produce the measurement, and
> withdrawing `--embedding-default` until one exists.

The owner reviewed the gap described above, including the measured cost of
withdrawal — existing installs keep resolving from their on-disk descriptor, so
the only cost is one guidance string, and a CI gate now holds that string in
sync with whether the flag is wired — and chose to keep the feature as it
stands.

This is a decision about what to ship. It is not a claim about retrieval
quality, and it does not close the deferral. Everything under *What remains
unproven* still holds: this model's ranking quality here rests on being the same
model and prompt format the reference toolchain uses by default, not on a
measurement in this project's harness. Both READMEs state that where the feature
is recommended, so a user adopting it adopts that caveat knowingly.

The closing condition stands as written; it is simply no longer treated as
blocking. If the measurement is ever produced it closes the deferral. Until
then, this record is the answer to why an unmeasured default ships.
