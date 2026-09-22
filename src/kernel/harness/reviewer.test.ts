import { describe, expect, it } from "vitest";
import { digestBytes } from "../templates/canonical.js";
import { normalizeHostReview, reviewerMechanism, type HostReviewInvocation, type HostReviewResult } from "./reviewer.js";

const requestDigest = digestBytes("request");
const result: HostReviewResult = {
  requestDigest,
  criteria: [{ criterionId: "meaning", verdict: "pass", evidence: [{ kind: "external", uri: "https://example.org/reference", summary: "Approved evidence" }], rationale: "Supported by the supplied source." }],
};
const invocation: HostReviewInvocation = {
  runtime: "hermes", mechanism: "hermes.delegate-task", invocationRef: "delegate-event-7",
  status: "completed", reviewerRole: "separate", isolationLevel: "instruction-only",
  enforcementEvidenceSource: "none", claimSource: "agent-transcribed",
};

describe("host reviewer normalization", () => {
  it.each([
    ["claude", "claude.plugin-agent"],
    ["codex", "codex.subagent"],
    ["codex", "codex.custom-agent"],
    ["hermes", "hermes.delegate-task"],
  ])("supports a separate instruction-only %s reviewer using %s", (runtime, mechanism) => {
    const normalized = normalizeHostReview(requestDigest, { ...invocation, runtime, mechanism }, result);
    expect(normalized.claim.isolationLevel).toBe("instruction-only");
    expect(normalized.claim.independenceVerifiedByOms).toBe(false);
    expect(normalized.claim.claimSource).toBe("agent-transcribed");
    expect(normalized.claim.resultDigest).toBe(normalized.resultDigest);
    expect(normalized.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(normalized.criteria).toEqual(result.criteria);
  });
  it("binds each returned decision and does not mutate inputs", () => {
    const before = structuredClone({ invocation, result });
    const original = normalizeHostReview(requestDigest, invocation, result);
    const failedCriterion = { ...result, criteria: [{ ...result.criteria[0]!, verdict: "fail" as const }] };
    expect(normalizeHostReview(requestDigest, invocation, failedCriterion).resultDigest).not.toBe(original.resultDigest);
    expect({ invocation, result }).toEqual(before);
  });
  it.each(["unavailable", "failed"] as const)("preserves %s without a successful result hash", status => {
    const normalized = normalizeHostReview(requestDigest, { ...invocation, status }, null);
    expect(normalized.status).toBe(status);
    expect(normalized.resultDigest).toBeNull();
    expect(normalized.criteria).toEqual([]);
  });
  it("rejects unknown and cross-host mechanisms", () => {
    expect(() => reviewerMechanism("hermes", "codex.subagent")).toThrow("REVIEWER_UNAVAILABLE");
    expect(() => reviewerMechanism("unknown", "hermes.delegate-task")).toThrow("REVIEWER_UNAVAILABLE");
  });
  it("rejects schema failure, missing terminal result and stale request", () => {
    expect(() => normalizeHostReview(requestDigest, { ...invocation, schemaValid: false }, result)).toThrow("REVIEW_SCHEMA_INVALID");
    expect(() => normalizeHostReview(requestDigest, invocation, null)).toThrow("REVIEW_SCHEMA_INVALID");
    expect(() => normalizeHostReview(requestDigest, { ...invocation, status: "failed" }, result)).toThrow("REVIEW_SCHEMA_INVALID");
    expect(() => normalizeHostReview(digestBytes("other"), invocation, result)).toThrow("SNAPSHOT_STALE");
  });
  it("rejects self-review and fabricated OMS execution provenance", () => {
    expect(() => normalizeHostReview(requestDigest, { ...invocation, reviewerRole: "writer" }, result)).toThrow("writer-only");
    expect(() => normalizeHostReview(requestDigest, { ...invocation, writerSessionId: "same", reviewerSessionId: "same" }, result)).toThrow("separate");
    expect(() => normalizeHostReview(requestDigest, { ...invocation, claimSource: "oms-derived" }, result)).toThrow("not an OMS-observed");
    expect(() => normalizeHostReview(requestDigest, { ...invocation, enforcementEvidenceSource: "oms-derived" }, result)).toThrow("not an OMS-observed");
    expect(() => normalizeHostReview(requestDigest, { ...invocation, enforcementEvidenceSource: "host" }, result)).toThrow("Transcribed");
  });
  it("keeps definition equality separate from actual enforcement", () => {
    const claude = { ...invocation, runtime: "claude", mechanism: "claude.plugin-agent" };
    const observed = normalizeHostReview(requestDigest, claude, result, true);
    expect(observed.claim.definitionDigestVerifiedByOms).toBe(true);
    expect(observed.claim.isolationLevel).toBe("instruction-only");
    expect(observed.claim.independenceVerifiedByOms).toBe(false);
    expect(() => normalizeHostReview(requestDigest, invocation, result, true)).toThrow("no shipped definition");
    const direct = normalizeHostReview(requestDigest, { ...claude, claimSource: "host", isolationLevel: "tool-restricted", enforcementEvidenceSource: "host" }, result);
    expect(direct.claim.isolationLevel).toBe("tool-restricted");
    expect(() => normalizeHostReview(requestDigest, { ...claude, isolationLevel: "tool-restricted" }, result)).toThrow("enforcement evidence");
  });
  it("rejects malformed criterion values rather than emitting a completion fallback", () => {
    expect(() => normalizeHostReview(requestDigest, invocation, { ...result, criteria: [null] } as unknown as HostReviewResult)).toThrow("REVIEW_SCHEMA_INVALID");
    expect(() => normalizeHostReview(requestDigest, invocation, { ...result, criteria: [{ ...result.criteria[0]!, verdict: "PASS" }] } as unknown as HostReviewResult)).toThrow("invalid verdict");
  });
});
