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
