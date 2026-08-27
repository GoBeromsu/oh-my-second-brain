# R2 boost-arm preregistration

This is the immutable preregistration for the `boost-c040` measurement profile.
The harness executes all arms through the production assemble seam with
`download:false`; no model download or network access is permitted.

## Shipped baseline and experiment status

The shipped ranking default is `boost-additive`, the released v0.3.0 baseline:
after RRF it returns `score: hit.score + boost`, with no per-list reordering.
It is not a C040 experiment arm.

`boost-k-scale`, `boost-per-list`, and `boost-zero` are the three frozen C040
experiment arms. They are candidates for a future ranking default, not the
current default.

## Arms

Exactly these three arm identifiers are registered (order is not significant):

- `boost-k-scale` — provenance boost applied on the RRF k scale.
- `boost-per-list` — preregistered per-list weighting candidate.
- `boost-zero` — ablation/control with no boost.

A manifest that omits an arm or adds an arm fails closed. Arm IDs are not chosen
after inspecting results.

## Dataset and qrels

The built-in fixture set contains 28 curated queries spanning these nine classes:
`ko`, `ko-inflected`, `ko-verb-inflected`, `다단어-AND-0hit`, `en`, `mixed`,
`phrase`, `conceptual`, and `frontmatter-constrained`. Every row has at least
one scored qrel, including the deliberate 0-hit class. Real-vault labels remain
vault-owner evidence: `OMS_GOLDEN_QUERIES` may inject them, but uncurated rows
are skipped and never assigned fabricated relevance.

The qrels digest is SHA-256 over canonical JSON rows sorted by `queryId`, then
`docPath`:

```json
[{"queryId":"…","docPath":"…","relevance":1}]
```

`OMS_PREREG_QRELS_HASH` (or `OMS_PREREG_QRELS`) supplies the frozen digest to the
checker. For local harness tests only, the built-in fixture digest is
`sha256:b13ac9653fdbec762c5db46ea10fe58c521da55a0144b8c36e1bc5fa12f7da28`.
Object insertion order and whitespace do not affect the digest.

## C040 rule and winner selection

The checker calculates, rather than trusts, the verdict from measured values.
All three registered arms are measured before selection. The manifest's
`winnerArmId` must be either `boost-k-scale` or `boost-per-list`; the
`boost-zero` ablation cannot be selected. Any winner alias under `verdict`
must agree with `winnerArmId`. The declared candidate is compared with the
`boost-zero` baseline under C040, so selection is evidence-driven rather than
hard-coded. A winner exists only when the calculated C040 result passes:

- every `primaryClasses` nDCG@10 delta is at least `+0.05`;
- every other class delta is at least `-0.02`;
- candidate p95 is no more than `1.5x` baseline p95;
- the bootstrap CI lower bound for candidate-minus-baseline improvement is
  strictly greater than zero.

The manifest's claimed `verdict` is evidence to compare, not authority. A
failed calculated C040 result means there is no release winner.

The release manifest is supplied from a real-vault run and may redact
vault-specific identifiers; source vault notes and labels remain private. A
A fixture or synthetic manifest is never a release artifact.

## Release-gate scope

`boost-c040` is required only for a release whose shipped ranking default
differs from the released `boost-additive` baseline. A release that ships that
baseline passes this gate with a receipt and requires no
`docs/measurements/boost-c040.json` manifest. Adopting any experiment arm as
the shipped default requires the real-vault, signed manifest described here.
There is no waiver for `boost-c040`.
