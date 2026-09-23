import { describe, expect, it } from "vitest";
import { digestBytes } from "../templates/canonical.js";
import {
  COMPLETION_SCHEMA_VERSION,
  CompletionContractError,
  type CompletionCriterion,
  type CompletionRubric,
  type CriterionResult,
  type ReviewExecutionClaim,
  buildEvidenceManifest,
  computeReviewerPromptDigest,
  computeSemanticResultDigest,
  computeTaskId,
  computeRubricDigest,
  createReviewRequest,
  createReadSnapshot,
  createTaskBinding,
  computeFindingId,
  evaluateCompletion,
  renderReviewerPrompt,
  verifyEvidence,
} from "./completion-contract.js";

const CONTRACT_DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

function noteEvidence(note: ReturnType<typeof createReadSnapshot>) {
  const newline = note.bytes.indexOf(0x0a);
  const firstLine = note.bytes.slice(0, newline < 0 ? note.bytes.byteLength : newline + 1);
  return {
    kind: "note-span" as const,
    lineSpan: { start: 1, end: 1 },
    sliceDigest: digestBytes(firstLine),
  };
}

function rubricFor(note: ReturnType<typeof createReadSnapshot>): CompletionRubric {
  const sourceRefs = [noteEvidence(note)];
  const criterion: CompletionCriterion = {
    criterionId: "criterion/summary",
    statement: "The note contains a useful summary.",
    evidenceRequirement: "Quote the note span that supports the summary.",
    requireByteVerification: true,
    sourceRefs,
  };
  return { rubricId: "rubric/task", criteria: [criterion] };
}

function claim(requestDigest: string, resultDigest: string | null, overrides: Partial<ReviewExecutionClaim> = {}): ReviewExecutionClaim {
  return {
    runtime: "test-host",
    mechanism: "separate-reviewer",
    invocationRef: "host-event-1",
    requestDigest: requestDigest as ReviewExecutionClaim["requestDigest"],
    resultDigest: resultDigest as ReviewExecutionClaim["resultDigest"],
    status: "completed",
    reviewerRole: "separate",
    isolationLevel: "instruction-only",
    enforcementEvidenceSource: "none",
    claimSource: "host",
    independenceVerifiedByOms: false,
    ...overrides,
  };
}

function fixture() {
  const note = createReadSnapshot("notes/task.md", "Summary\nDetails\n");
  const rubric = rubricFor(note);
  const binding = createTaskBinding({
    vaultFingerprint: "vault-a",
    templateId: "task",
    notePath: note.path,
    contractDigest: CONTRACT_DIGEST,
    rubricDigest: computeRubricDigest(rubric),
  });
  const evidenceManifest = buildEvidenceManifest({ rubric });
  const request = createReviewRequest({ binding, note, rubric, evidenceManifest, targetIds: ["criterion/summary"] });
  const criterionResults: readonly CriterionResult[] = [{
    criterionId: "criterion/summary",
    verdict: "pass",
    evidence: [noteEvidence(note)],
    rationale: "The first line is the summary.",
  }];
  const resultDigest = computeSemanticResultDigest({ requestDigest: request.requestDigest, criteria: criterionResults });
  const review = {
    requestDigest: request.requestDigest,
    status: "completed" as const,
    claim: claim(request.requestDigest, resultDigest),
    criteria: criterionResults,
    resultDigest,
  };
  const snapshot = {
    note,
    contractDigest: CONTRACT_DIGEST,
    rubric,
    evidenceSnapshots: [],
  };
  return { note, rubric, binding, request, review, snapshot, machine: {
    status: "pass" as const,
    taskId: computeTaskId(binding),
    noteDigest: note.digest,
    contractDigest: CONTRACT_DIGEST,
    findings: [],
  } };
}

describe("completion contract", () => {
  it("reproduces a task and request binding without mutating caller data", () => {
    const input = {
      vaultFingerprint: "vault-a",
      templateId: "task",
      notePath: "./notes/task.md",
      contractDigest: CONTRACT_DIGEST,
      rubricDigest: null,
    } as const;
    const before = JSON.stringify(input);
    const binding = createTaskBinding(input);
    const first = computeTaskId(binding);
    const second = computeTaskId({ ...binding });
    expect(first).toBe(second);
    expect(binding.notePath).toBe("notes/task.md");
    expect(JSON.stringify(input)).toBe(before);
    expect(computeTaskId({ ...binding, vaultFingerprint: "vault-b" })).not.toBe(first);
    expect(computeTaskId({ ...binding, notePath: "notes/other.md" })).not.toBe(first);
    expect(computeFindingId("required", "field/title")).toBe(computeFindingId("required", "field/title"));
    expect(() => createTaskBinding({ ...input, secret: "not-accepted" } as never)).toThrow(CompletionContractError);

    const bytes = new TextEncoder().encode("snapshot");
    const snapshot = createReadSnapshot("notes/snapshot.md", bytes);
    bytes[0] = 0;
    expect(new TextDecoder().decode(snapshot.bytes)).toBe("snapshot");
  });

  it("canonicalizes request target and evidence order", () => {
    const value = fixture();
    const first = createReviewRequest({
      binding: value.binding,
      note: value.note,
      rubric: value.rubric,
      evidenceManifest: value.request.evidenceManifest,
      targetIds: ["target/z", "target/a"],
    });
    const second = createReviewRequest({
      binding: value.binding,
      note: value.note,
      rubric: value.rubric,
      evidenceManifest: [...value.request.evidenceManifest].reverse(),
      targetIds: ["target/a", "target/z"],
    });
    expect(second.requestDigest).toBe(first.requestDigest);
    expect(second.reviewerPromptDigest).toBe(first.reviewerPromptDigest);
  });

  it("accepts machine pass plus an honest separate instruction-only review", () => {
    const value = fixture();
    const result = evaluateCompletion({ ...value, before: value.snapshot, after: value.snapshot });
    expect(result).toMatchObject({ status: "complete", complete: true });
    expect(result.failures).toEqual([]);
  });

  it("rejects a changed note snapshot even when both evaluators say pass", () => {
    const value = fixture();
    const changed = { ...value.snapshot, note: createReadSnapshot(value.note.path, "Changed\nDetails\n") };
    const result = evaluateCompletion({ ...value, before: value.snapshot, after: changed });
    expect(result.status).toBe("incomplete");
    expect(result.failures.some(failure => failure.code === "SNAPSHOT_STALE")).toBe(true);
  });

  it("rejects criterion fail and insufficient-evidence verdicts", () => {
    const value = fixture();
    const failedCriteria: readonly CriterionResult[] = [{ ...value.review.criteria[0]!, verdict: "fail" }];
    const failedResultDigest = computeSemanticResultDigest({ requestDigest: value.request.requestDigest, criteria: failedCriteria });
    const failedReview = {
      ...value.review,
      claim: claim(value.request.requestDigest, failedResultDigest),
      criteria: failedCriteria,
      resultDigest: failedResultDigest,
    };
    const failed = evaluateCompletion({ ...value, review: failedReview, before: value.snapshot, after: value.snapshot });
    expect(failed.failures.some(failure => failure.code === "CRITERION_FAILED")).toBe(true);

    const insufficientCriteria: readonly CriterionResult[] = [{ ...value.review.criteria[0]!, verdict: "insufficient-evidence" }];
    const insufficientResultDigest = computeSemanticResultDigest({ requestDigest: value.request.requestDigest, criteria: insufficientCriteria });
    const insufficientReview = {
      ...value.review,
      claim: claim(value.request.requestDigest, insufficientResultDigest),
      criteria: insufficientCriteria,
      resultDigest: insufficientResultDigest,
    };
    const insufficient = evaluateCompletion({ ...value, review: insufficientReview, before: value.snapshot, after: value.snapshot });
    expect(insufficient.failures.some(failure => failure.code === "INSUFFICIENT_EVIDENCE")).toBe(true);

    const missingCriteria: readonly CriterionResult[] = [];
    const missingResultDigest = computeSemanticResultDigest({ requestDigest: value.request.requestDigest, criteria: missingCriteria });
    const missingReview = {
      ...value.review,
      claim: claim(value.request.requestDigest, missingResultDigest),
      criteria: missingCriteria,
      resultDigest: missingResultDigest,
    };
    const missing = evaluateCompletion({ ...value, review: missingReview, before: value.snapshot, after: value.snapshot });
    expect(missing.failures.some(failure => failure.code === "CRITERION_MISSING")).toBe(true);
  });

  it("rejects missing rubric, unavailable reviewer, and writer-only PASS", () => {
    const value = fixture();
    const unavailable = evaluateCompletion({
      ...value,
      review: null,
      before: value.snapshot,
      after: value.snapshot,
    });
    expect(unavailable.failures.some(failure => failure.code === "REVIEWER_UNAVAILABLE")).toBe(true);

    const failedReview = {
      requestDigest: value.request.requestDigest,
      status: "failed" as const,
      claim: claim(value.request.requestDigest, null, { status: "failed", resultDigest: null }),
      criteria: [],
      resultDigest: null,
    };
    const failed = evaluateCompletion({ ...value, review: failedReview, before: value.snapshot, after: value.snapshot });
    expect(failed.failures.some(failure => failure.code === "REVIEW_EXECUTION_FAILED")).toBe(true);

    const writerReview = {
      ...value.review,
      claim: claim(value.request.requestDigest, value.review.resultDigest, { reviewerRole: "writer" }),
    };
    const writer = evaluateCompletion({ ...value, review: writerReview, before: value.snapshot, after: value.snapshot });
    expect(writer.failures.some(failure => failure.code === "REVIEW_EXECUTION_FAILED")).toBe(true);

    const noRubricBinding = createTaskBinding({
      ...value.binding,
      rubricDigest: null,
    });
    const noRubricRequest = createReviewRequest({
      binding: noRubricBinding,
      note: value.note,
      rubric: null,
      evidenceManifest: [],
      targetIds: [],
    });
    const noRubricSnapshot = { ...value.snapshot, rubric: null, contractDigest: CONTRACT_DIGEST };
    const noRubric = evaluateCompletion({
      request: noRubricRequest,
      machine: { ...value.machine, taskId: computeTaskId(noRubricBinding) },
      review: null,
      before: noRubricSnapshot,
      after: noRubricSnapshot,
    });
    expect(noRubric.failures.some(failure => failure.code === "RUBRIC_MISSING")).toBe(true);
  });

  it("bounds note spans and records external evidence as unverified", () => {
    const note = createReadSnapshot("notes/task.md", "one\ntwo\n");
    const valid = noteEvidence(note);
    expect(verifyEvidence(note, [valid], [])).toMatchObject({ valid: true });
    const outOfBounds = verifyEvidence(note, [{ ...valid, lineSpan: { start: 4, end: 4 } }], []);
    expect(outOfBounds.valid).toBe(false);
    expect(outOfBounds.failures.some(failure => failure.code === "EVIDENCE_INVALID")).toBe(true);
    const external = { kind: "external" as const, uri: "https://example.test/source", summary: "untrusted source" };
    expect(verifyEvidence(note, [external], [])).toMatchObject({
      valid: true,
      entries: [{ verification: "unverified-by-oms" }],
    });
  });

  it("pins prompt output and digest to the schema version and exact snapshot bytes", () => {
    const value = fixture();
    const input = {
      schemaVersion: COMPLETION_SCHEMA_VERSION,
      rubric: value.rubric,
      note: value.note,
      evidenceManifest: value.request.evidenceManifest,
    } as const;
    const prompt = renderReviewerPrompt(input);
    expect(prompt).toBe(renderReviewerPrompt({ ...input }));
    expect(computeReviewerPromptDigest(input)).toBe(digestBytes(prompt));
    expect(prompt).not.toBe(renderReviewerPrompt({ ...input, note: createReadSnapshot(value.note.path, "Different\nDetails\n") }));
  });
});
