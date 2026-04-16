# Runbook — Verify OMSB against a live Obsidian-native adapter or CLI path

Related issue: #9

## Goal
Prove the remaining native-operation boundary in a real Obsidian-facing environment.

## Preconditions
- a sanitized demo vault
- a real Obsidian-native execution surface available (CLI, plugin bridge, or equivalent)
- clear understanding of which user-visible note operation will be tested

## Candidate flows
- note creation through a native surface
- note move / route through a native surface
- note rename through a native surface

## Verification sequence

### A. Native-available happy path
1. Choose a note operation with a deterministic routing result.
2. Ensure the native adapter/CLI is available.
3. Trigger the operation through OMSB.
4. Confirm:
   - OMSB chooses `obsidian-native` mode
   - the note operation succeeds in the vault
   - resulting note location/name matches the expected route

### B. Native-unavailable fallback path
1. Disable or remove the native adapter/CLI path.
2. Trigger the same or similar deterministic route.
3. Confirm OMSB does **not** silently fall back to filesystem mutation.
4. Confirm a proposal artifact is created instead.

## Evidence to capture
- command transcript or UI screenshots
- resulting note path / filename evidence
- proposal artifact evidence for the unavailable-native case
- any adapter setup requirements or failure notes

## Pass criteria
- at least one native-happy path is verified successfully, or a concrete blocker is documented
- at least one native-unavailable fallback path is verified and produces a proposal
- environment prerequisites are written down for future reruns

## Failure handling
If native execution cannot be completed:
1. record the adapter/CLI missing piece precisely
2. save logs or screenshots
3. file a targeted follow-up issue describing the blocker and expected behavior
