import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestBytes } from "../templates/canonical.js";
import { parseTemplatePolicy, serializeDerivedProjection } from "../templates/policy.js";
import { controlGenerationDigest, expectedProjectionManaged, taxonomyRouting } from "../templates/resolver.js";
import type { CriterionResult, ReviewRequest, SemanticReview } from "../conventions/completion-contract.js";
import { normalizeHostReview, type HostReviewInvocation } from "../harness/reviewer.js";
import { checkSavedNote, completeSavedNote, type CompletionCheckpoint } from "./check.js";

const roots: string[] = [];
const encoder = new TextEncoder();
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const NOTE = "---\ntemplate: note\nstatus: open\n---\n\n## Summary\n\nThe saved body an agent wrote.\n";

/** Same slicing rule the contract uses: a line keeps its terminating newline. */
function sliceOf(text: string, start: number, end: number) {
  return digestBytes(text.split(/(?<=\n)/u).slice(start - 1, end).join(""));
}

const SUMMARY_SPAN = { kind: "note-span" as const, lineSpan: { start: 6, end: 8 }, sliceDigest: sliceOf(NOTE, 6, 8) };
const TEMPLATE_MARKDOWN = "---\ntemplate: note\nstatus: open\n---\n\n## Summary\n";

function layer(templatePath: string, markdown: string, extra: Record<string, unknown> = {}) {
  return {
    templatePath,
    approvedMarkdown: markdown,
    approvedMarkdownDigest: digestBytes(markdown),
    fields: {},
    headings: [],
    semanticCriteria: [],
    ...extra,
  };
}

function policyDocument(criteria: readonly unknown[]) {
  return {
    version: 4,
    properties: { status: { type: "select", intent: "Workflow state.", allowedValues: ["open", "closed"] } },
    default: layer(".oms/templates/default.md", ""),
    templates: {
      note: layer(".oms/templates/note.md", TEMPLATE_MARKDOWN, {
        templateId: "note",
        fields: { status: { property: "status", required: true } },
        headings: [{ headingId: "summary", title: "Summary", level: 2, required: true }],
        semanticCriteria: criteria,
      }),
    },
  };
}

async function vault(options: { readonly criteria?: readonly unknown[]; readonly note?: string | null } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-check-"));
  roots.push(root);
  const policyText = JSON.stringify(policyDocument(options.criteria ?? [{
    criterionId: "summary-supported",
    statement: "The summary reflects the cited evidence.",
    evidenceRequirement: "Cite the summary lines.",
    required: true,
    sourceRefs: [SUMMARY_SPAN],
  }]));
  const taxonomyText = JSON.stringify({ templates: { note: { templateFolder: "notes" } }, folders: { notes: { intent: "Notes." } } });
  const generationDigest = controlGenerationDigest(encoder.encode(policyText), encoder.encode(taxonomyText));
  await mkdir(join(root, ".oms", "templates"), { recursive: true });
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, ".oms", "template-policy.json"), policyText);
  await writeFile(join(root, ".oms", "taxonomy.json"), taxonomyText);
  await writeFile(join(root, ".oms", "types.json"), serializeDerivedProjection({
    version: "oms.types.v2",
    generatedFrom: generationDigest,
    managed: expectedProjectionManaged(parseTemplatePolicy(policyText), taxonomyRouting(".oms/taxonomy.json", encoder.encode(taxonomyText)), generationDigest),
  }));
  await writeFile(join(root, ".oms", "templates", "default.md"), "");
  await writeFile(join(root, ".oms", "templates", "note.md"), TEMPLATE_MARKDOWN);
  const note = options.note === undefined ? NOTE : options.note;
  if (note !== null) await writeFile(join(root, "notes", "one.md"), note);
  return root;
}

function target(root: string) {
  return { vault: root, source: "explicit" as const };
}

async function passingCheck(root: string, evidencePaths: readonly string[] = []) {
  return checkSavedNote({ target: target(root), notePath: "notes/one.md", templateId: "note", evidencePaths });
}

const INVOCATION: HostReviewInvocation = {
  runtime: "codex",
  mechanism: "codex.subagent",
  invocationRef: "thread-42",
  status: "completed",
  reviewerRole: "separate",
  isolationLevel: "instruction-only",
  enforcementEvidenceSource: "none",
  claimSource: "agent-transcribed",
  writerSessionId: "writer-1",
  reviewerSessionId: "reviewer-2",
};

/** A real separate review is normalized by the same adapter the hosts use. */
function separateReview(request: ReviewRequest, criteria?: readonly CriterionResult[], invocation: HostReviewInvocation = INVOCATION): SemanticReview {
  const results = criteria ?? (request.rubric?.criteria ?? []).map(criterion => ({
    criterionId: criterion.criterionId,
    verdict: "pass" as const,
    evidence: criterion.sourceRefs,
  }));
  return normalizeHostReview(request.requestDigest, invocation, { requestDigest: request.requestDigest, criteria: results });
}

async function vaultSignature(root: string): Promise<string> {
  const files = [".oms/template-policy.json", ".oms/taxonomy.json", ".oms/types.json", ".oms/templates/note.md", "notes/one.md"];
  const rows = await Promise.all(files.map(async file => {
    try {
      return `${file} ${digestBytes(await readFile(join(root, file)))}`;
    } catch {
      return `${file} absent`;
    }
  }));
  return rows.join("\n");
}

describe("checkSavedNote", () => {
  it("reads the saved file and returns machine findings with an immutable review request", async () => {
    const root = await vault();
    const before = await vaultSignature(root);
    const report = await passingCheck(root);
    expect(report.status).toBe("pass");
    expect(report.machine?.status).toBe("pass");
    expect(report.request?.notePath).toBe("notes/one.md");
    expect(report.request?.noteDigest).toBe(digestBytes(NOTE));
    expect(report.checkpoint?.requestDigest).toBe(report.request?.requestDigest);
    expect(report.request?.targetIds).toContain("field/status");
    expect(report.request?.targetIds).toContain("heading/summary");
    expect(report.request?.targetIds).toContain("criterion/summary-supported");
    expect(await vaultSignature(root)).toBe(before);
  });

  it("fails mechanics on the saved bytes without repairing the note", async () => {
    const root = await vault({ note: "---\ntemplate: note\nstatus: unknown\n---\n\nNo summary heading.\n" });
    const report = await passingCheck(root);
    expect(report.status).toBe("fail");
    expect(report.machine?.findings.map(finding => finding.targetId)).toEqual(
      expect.arrayContaining(["field/status", "heading/summary"]),
    );
    expect(await readFile(join(root, "notes/one.md"), "utf8")).toContain("status: unknown");
  });

  it("refuses a current-directory target before reading the vault", async () => {
    const root = await vault();
    const report = await checkSavedNote({ target: { vault: root, source: "cwd" }, notePath: "notes/one.md" });
    expect(report.status).toBe("rejected");
    expect(report.rejection?.code).toBe("TARGET_UNVERIFIED");
  });

  it("reports an unsaved note instead of creating one", async () => {
    const root = await vault({ note: null });
    const report = await passingCheck(root);
    expect(report.rejection?.code).toBe("NOTE_MISSING");
    await expect(readFile(join(root, "notes/one.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks an unbound note against the default layer alone", async () => {
    const root = await vault({ note: "---\ntitle: Plain\n---\n\nOrdinary note.\n" });
    const report = await checkSavedNote({ target: target(root), notePath: "notes/one.md" });
    expect(report.status).toBe("pass");
    expect(report.templateId).toBeNull();
  });

  it("rejects a binding from another note and a stale contract digest", async () => {
    const root = await vault();
    const report = await passingCheck(root);
    const binding = report.binding!;
    const otherNote = await checkSavedNote({
      target: target(root), notePath: "notes/one.md", templateId: "note",
      binding: { ...binding, notePath: "notes/other.md" },
    });
    expect(otherNote.rejection?.code).toBe("TASK_BINDING_MISMATCH");
    const stale = await checkSavedNote({
      target: target(root), notePath: "notes/one.md", templateId: "note",
      binding: { ...binding, contractDigest: digestBytes("different") },
    });
    expect(stale.rejection?.code).toBe("SNAPSHOT_STALE");
  });

  it("binds declared evidence files and refuses unsafe or missing ones", async () => {
    const root = await vault();
    await writeFile(join(root, "notes", "evidence.md"), "Supporting source.\n");
    const withEvidence = await passingCheck(root, ["notes/evidence.md"]);
    expect(withEvidence.request?.evidenceManifest).toContainEqual(
      expect.objectContaining({ kind: "vault-file", path: "notes/evidence.md" }),
    );
    expect((await passingCheck(root, ["../outside.md"])).rejection?.code).toBe("EVIDENCE_INVALID");
    expect((await passingCheck(root, ["notes/absent.md"])).rejection?.code).toBe("EVIDENCE_MISSING");
  });

  it("stops the evaluation while a contract publication is in progress", async () => {
    const root = await vault();
    await writeFile(join(root, ".oms", "template-transaction.json"), JSON.stringify({ status: "in-progress" }));
    expect((await passingCheck(root)).rejection?.code).toBe("CONTRACT_TRANSACTION_IN_PROGRESS");
  });

  it("reports a missing approved authority instead of an empty contract", async () => {
    const root = await vault();
    await rm(join(root, ".oms", "template-policy.json"));
    expect((await passingCheck(root)).rejection?.code).toBe("CONTRACT_UNVERIFIABLE");
  });

  it("survives a JSON round trip of the checkpoint", async () => {
    const root = await vault();
    const report = await passingCheck(root);
    const restored = JSON.parse(JSON.stringify(report.checkpoint)) as CompletionCheckpoint;
    expect(restored.requestDigest).toBe(report.checkpoint?.requestDigest);
    expect(restored.noteDigest).toBe(report.checkpoint?.noteDigest);
    expect(restored.binding.notePath).toBe("notes/one.md");
  });
});

describe("completeSavedNote", () => {
  it("completes only with mechanics plus a real separate review of the same inputs", async () => {
    const root = await vault();
    const checked = await passingCheck(root);
    const before = await vaultSignature(root);
    const report = await completeSavedNote({
      target: target(root),
      checkpoint: JSON.parse(JSON.stringify(checked.checkpoint)) as unknown,
      review: separateReview(checked.request!),
    });
    expect(report.failures).toEqual([]);
    expect(report.status).toBe("complete");
    expect(report.evaluation?.complete).toBe(true);
    expect(await vaultSignature(root)).toBe(before);
  });

  it("refuses a writer-authored self review", async () => {
    const root = await vault();
    const checked = await passingCheck(root);
    // The adapter refuses a writer-authored verdict before OMS evaluates it.
    expect(() => separateReview(checked.request!, undefined, { ...INVOCATION, reviewerRole: "writer" }))
      .toThrow(/writer-only review is not admissible/);
    const report = await completeSavedNote({
      target: target(root),
      checkpoint: checked.checkpoint,
      review: { ...separateReview(checked.request!), claim: { ...separateReview(checked.request!).claim, reviewerRole: "writer" } },
    });
    expect(report.status).toBe("rejected");
    expect(report.rejection?.code).toBe("REVIEW_SCHEMA_INVALID");
  });

  it("refuses a review whose writer and reviewer are the same exposed session", async () => {
    const root = await vault();
    const checked = await passingCheck(root);
    expect(() => separateReview(checked.request!, undefined, { ...INVOCATION, reviewerSessionId: "writer-1" }))
      .toThrow(/writer and reviewer sessions must be separate/);
    const forged = separateReview(checked.request!);
    const report = await completeSavedNote({
      target: target(root),
      checkpoint: checked.checkpoint,
      review: { ...forged, claim: { ...forged.claim, reviewerSessionId: "writer-1" } },
    });
    expect(report.status).toBe("rejected");
  });

  it("does not complete when the note changed after check", async () => {
    const root = await vault();
    const checked = await passingCheck(root);
    await writeFile(join(root, "notes/one.md"), `${NOTE}\nEdited after the check.\n`);
    const report = await completeSavedNote({
      target: target(root),
      checkpoint: checked.checkpoint,
      review: separateReview(checked.request!),
    });
    expect(report.status).toBe("incomplete");
    expect(report.failures.map(failure => failure.code)).toContain("SNAPSHOT_STALE");
  });

  it("treats an unavailable reviewer as incomplete rather than a pass", async () => {
    const root = await vault();
    const checked = await passingCheck(root);
    const report = await completeSavedNote({
      target: target(root),
      checkpoint: checked.checkpoint,
      review: normalizeHostReview(checked.request!.requestDigest, { ...INVOCATION, status: "unavailable" }, null),
    });
    expect(report.status).not.toBe("complete");
  });

  it("does not complete a note whose rubric has no approved criteria", async () => {
    const root = await vault({ criteria: [] });
    const checked = await passingCheck(root);
    expect(checked.rubric).toBeNull();
    const report = await completeSavedNote({
      target: target(root),
      checkpoint: checked.checkpoint,
      review: separateReview(checked.request!, []),
    });
    expect(report.status).not.toBe("complete");
    expect(report.failures.map(failure => failure.code)).toContain("RUBRIC_MISSING");
  });
});
