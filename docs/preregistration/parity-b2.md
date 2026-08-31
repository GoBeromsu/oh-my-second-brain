# Preregistration — B2 parity profile

> **Standing.** This procedure was frozen *before the capability it measures
> existed*. Explicit expansion and real HyDE generation are now implemented and
> have been exercised locally, but B2 still cannot run until the B1 gate passes.
> The implementation does not reopen this protocol: `parity-outcome.ts` requires
> a preserved passing B1 outcome before it will admit B2, and
> `parity-stop-policy.ts` still makes every qmd-replacement claim conditional on
> a passing `b2-parity` profile.

## Why this is written before the run, and before the code

A preregistration is a commitment device, not a report. Its whole value is that
it is fixed while the outcome is still unknown — so the moment to write it is
before there is any result to rationalise, which for B2 is now.

The alternative would be to write it after B1 passes and the generator is built.
By then the author would know how the expansion strategy behaves, and every
choice of modality set or failure policy would be open to the suspicion of having
been fitted to what was already measured. That is exactly the failure mode
`FORBIDDEN_THRESHOLD_OVERRIDES` exists to prevent at runtime.

## Relationship to B1

B1 (`parity-b1.md`) is the pre-B2 foundation gate. B2 is the release gate for
0.10.0 and the only profile that may authorise a replacement claim.

| | B1 foundation | B2 parity |
|---|---|---|
| Modalities scored | `lex`, `vec` | `lex`, `vec`, `hyde` |
| qmd expansion | disabled, for like-for-like arms | enabled, since OMS now has the capability |
| Passing unlocks | B2 implementation, 0.9.0 release | 0.10.0 release, replacement claim |

## Frozen thresholds

**B2 uses the identical constants B1 does** — `MODALITY_FLOORS`,
`AGGREGATE_FLOORS`, `MAX_QMD_DEFICIT`, `MIN_CURATED_ROWS_PER_MODALITY`,
`REQUIRED_LANGUAGE_STRATA` and `OPERABILITY_LIMITS` in
`test/golden-set/parity-gate.ts`.

Those numbers are deliberately **not** restated here. A second copy in prose
could disagree with the constants that actually decide the verdict, and the copy
that drifted would be the one a reader trusted. B1's tables already record them;
this document records only what differs, which is the modality set above.

The one substantive addition is that `hyde` is scored as a first-class modality
and therefore must independently clear the per-modality floors and stay within
the allowed deficit against qmd's matching arm. Passing on aggregate while `hyde`
fails is not a pass: it would mean claiming parity on the strength of the two
capabilities OMS already had.

## Additional preconditions beyond B1's

Everything B1 requires still applies — the pinned comparator, the frozen query
set and curated qrels, the corpus digest, and an environment that has not tried
to move a threshold. B2 adds three:

1. **B1 must have passed.** `decideStopPolicy` grants `mayStartB2` only on a
   passing `b1-foundation` outcome. Admission requires the complete audited B1
   record, recomputes its gate and stop decision from preserved relevance and
   operability measurements, and exact-matches baseline, corpus, query/qrels,
   hardware/seed, candidate/depth/RRF settings, and embedding identity against
   B2. A copied pass flag or a pass from different evidence is inadmissible.
2. **The generate capability must be configured and real.** The explicit
   `qmd-v2.8.3` expansion profile and user-authored HyDE both fail loudly when no
   generator is installed; empty, malformed, duplicate, over-budget, or
   identity-only generation output is rejected. A scored B2 arm therefore cannot
   be produced by the removed identity fallback.
3. **The comparison must be like-for-like in the other direction.** B1 disables
   qmd's expansion so the arms match; B2 enables it, so the frozen settings must
   record expansion as on for **both** arms. Comparing OMS-with-expansion against
   qmd-without would flatter OMS by exactly the capability under test.

## Failure policy

A miss on any relevance or operability bound blocks the 0.10.0 release and every
qmd-replacement claim, per `assertReleasePermitted` and
`assertReplacementClaimPermitted`. Preserve the raw evidence, change no
threshold, qrels file, or retrieval setting, and open a separately reviewed
retrieval-correction plan.

The asymmetry with B1 is intentional. A B1 miss stops the plan before B2 begins;
a B2 miss stops the release while leaving the shipped 0.9.0 foundation intact,
because the foundation passed its own gate on its own evidence.

## What this document does not claim

It does not claim B2 is implemented, that a generator exists, that any parity run
has occurred, or that OMS replaces qmd. It records what would have to be true for
that last claim to become permissible.
