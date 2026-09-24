import { describe, expect, it } from "vitest";
import { digestBytes } from "../templates/canonical.js";
import {
  CompletionContractError,
  type CompletionCriterion,
  type CompletionRubric,
  computeFindingId,
  computeRubricDigest,
  computeTaskId,
  createReadSnapshot,
  createTaskBinding,
  validateReadSnapshot,
  validateRubric,
  validateTaskBinding,
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
  const criterion: CompletionCriterion = {
    criterionId: "criterion/summary",
    statement: "The note contains a useful summary.",
    evidenceRequirement: "Quote the note span that supports the summary.",
    requireByteVerification: true,
    sourceRefs: [noteEvidence(note)],
  };
  return { rubricId: "rubric/task", criteria: [criterion] };
}

describe("completion contract", () => {
  it("reproduces a task binding and finding id without mutating caller data", () => {
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
    expect(computeTaskId({ ...binding })).toBe(first);
    expect(binding.notePath).toBe("notes/task.md");
    expect(JSON.stringify(input)).toBe(before);
    expect(computeTaskId({ ...binding, vaultFingerprint: "vault-b" })).not.toBe(first);
    expect(computeTaskId({ ...binding, notePath: "notes/other.md" })).not.toBe(first);
    expect(computeFindingId("required", "field/title")).toBe(computeFindingId("required", "field/title"));
    expect(computeFindingId("required", "field/title")).not.toBe(computeFindingId("required", "field/status"));
    expect(() => createTaskBinding({ ...input, secret: "not-accepted" } as never)).toThrow(CompletionContractError);
    expect(() => validateTaskBinding({ ...binding, contractDigest: "not-a-digest" })).toThrow(/contractDigest/);
    expect(() => validateTaskBinding({ ...binding, notePath: "../outside.md" })).toThrow(CompletionContractError);
  });

  it("copies snapshot bytes and refuses a snapshot whose digest does not match", () => {
    const bytes = new TextEncoder().encode("snapshot");
    const snapshot = createReadSnapshot("notes/snapshot.md", bytes);
    bytes[0] = 0;
    expect(new TextDecoder().decode(snapshot.bytes)).toBe("snapshot");
    const revived = validateReadSnapshot({ ...snapshot, bytes: new Uint8Array(snapshot.bytes) });
    expect(revived.digest).toBe(snapshot.digest);
    expect(revived.bytes).not.toBe(snapshot.bytes);
    expect(() => validateReadSnapshot({ ...snapshot, digest: CONTRACT_DIGEST })).toThrow(/snapshot digest does not match/);
    expect(() => validateReadSnapshot({ path: snapshot.path, digest: snapshot.digest })).toThrow(/Uint8Array bytes/);
  });

  it("orders rubric criteria and evidence so a declared digest does not depend on authoring order", () => {
    const note = createReadSnapshot("notes/task.md", "Summary\nDetails\n");
    const rubric = rubricFor(note);
    const second: CompletionCriterion = {
      criterionId: "criterion/detail",
      statement: "The note explains the detail.",
      evidenceRequirement: "Quote the detail span.",
      sourceRefs: [],
    };
    const ordered = validateRubric({ ...rubric, criteria: [rubric.criteria[0]!, second] });
    const reversed = validateRubric({ ...rubric, criteria: [second, rubric.criteria[0]!] });
    expect(ordered.criteria.map(criterion => criterion.criterionId)).toEqual(["criterion/detail", "criterion/summary"]);
    expect(computeRubricDigest(ordered)).toBe(computeRubricDigest(reversed));
    expect(computeRubricDigest(null)).toBeNull();
    expect(computeRubricDigest(rubric)).not.toBe(computeRubricDigest(ordered));
    const external = { kind: "external" as const, uri: "https://example.test/source", summary: "untrusted source" };
    const forward = validateRubric({ ...rubric, criteria: [{ ...rubric.criteria[0]!, sourceRefs: [external, noteEvidence(note)] }] });
    const backward = validateRubric({ ...rubric, criteria: [{ ...rubric.criteria[0]!, sourceRefs: [noteEvidence(note), external] }] });
    expect(forward.criteria[0]?.sourceRefs).toEqual(backward.criteria[0]?.sourceRefs);
    expect(computeRubricDigest(forward)).toBe(computeRubricDigest(backward));
  });

  it("refuses an empty, duplicated, or malformed rubric instead of accepting a partial one", () => {
    const note = createReadSnapshot("notes/task.md", "Summary\nDetails\n");
    const rubric = rubricFor(note);
    expect(() => validateRubric({ rubricId: "rubric/task", criteria: [] })).toThrow(/criteria must be non-empty/);
    expect(() => validateRubric({ ...rubric, criteria: [rubric.criteria[0]!, rubric.criteria[0]!] })).toThrow(/duplicate criterion/);
    expect(() => validateRubric({ ...rubric, criteria: [{ ...rubric.criteria[0]!, sourceRefs: "none" }] })).toThrow(/sourceRefs must be an array/);
    expect(() => validateRubric({ ...rubric, criteria: [{ ...rubric.criteria[0]!, requireByteVerification: "yes" }] })).toThrow(/requireByteVerification must be boolean/);
    expect(() => validateRubric({ ...rubric, criteria: [{ ...rubric.criteria[0]!, acceptableEvidenceKinds: ["screenshot"] }] })).toThrow(/unknown evidence kind/);
    expect(() => validateRubric("rubric")).toThrow(/rubric must be an object/);
  });
});
