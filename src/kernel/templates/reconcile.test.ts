import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalDigest, outputDigest } from "./canonical.js";
import { buildTemplateInterview, validateInterviewAnswer, type TemplateInterview } from "./interview.js";
import type { InterviewLedgerAnswer } from "./interview-ledger.js";
import { buildReconcileCompositionManifest } from "./reconcile.js";
import * as reviewContextModule from "./review-context.js";
import { readTemplateReviewContext } from "./review-context.js";
import { executeTemplateTransaction } from "./transaction.js";
import type { Digest, TemplateCompositionManifest, TemplatePolicy } from "./types.js";

const roots: string[] = [];
const sha = (value: string): Digest => `sha256:${createHash("sha256").update(value).digest("hex")}`;

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(options: { readonly destinationClass?: "managed-default" | "registered-existing"; readonly richContract?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-reconcile-"));
  roots.push(root);
  await mkdir(join(root, ".oms"), { recursive: true });
  await mkdir(join(root, ".obsidian"), { recursive: true });
  await mkdir(join(root, "Templates"), { recursive: true });
  const policy = {
    version: 3,
    templateFolders: [{ path: "Templates", default: true }],
    base: { fields: {} },
    contracts: {
      note: {
        intent: "Notes",
        fields: options.richContract ? { title: { type: "text", required: false, intent: "Title" } } : {},
        views: [],
      },
    },
    templates: {
      note: {
        templateId: "note",
        destinationClass: options.destinationClass ?? "managed-default",
        renderer: "obsidian-core",
        sourceFolder: "Templates",
        sourcePath: "Templates/note.md",
        contract: "note",
        naming: "{{title}}.md",
      },
    },
  };
  await Promise.all([
    writeFile(join(root, ".oms/template-policy.json"), JSON.stringify(policy)),
    writeFile(join(root, ".oms/taxonomy.json"), JSON.stringify({ folders: {} })),
    writeFile(join(root, ".obsidian/types.json"), JSON.stringify({ types: { title: "text" } })),
    writeFile(join(root, "Templates/note.md"), "---\ntitle: Note\n---\nBody\n"),
  ]);
  return root;
}

function answerValue(question: TemplateInterview["questions"][number]): unknown {
  if (question.kind === "field-type") return "text";
  if (question.kind === "field-requiredness" || question.kind === "content-section-requiredness") return "optional";
  if (question.kind === "field-intent") return "note";
  if (question.kind === "content-order") return "unordered";
  if (question.kind === "contract-selection") return "note";
  if (question.kind === "deleted-source-disposition") return "retire";
  if (question.kind === "rename-identity") return question.choices?.[0] ?? "note";
  return "{{title}}.md";
}

function completeInterview(context: Awaited<ReturnType<typeof readTemplateReviewContext>>): { readonly answers: Readonly<Record<string, InterviewLedgerAnswer>>; readonly interview: TemplateInterview; } {
  let answers: Record<string, InterviewLedgerAnswer> = {};
  let interview = buildTemplateInterview(context, answers);
  for (let pass = 0; pass < 256 && interview.next !== undefined; pass += 1) {
    const question = interview.next;
    answers[question.questionId] = validateInterviewAnswer(question, answerValue(question));
    interview = buildTemplateInterview(context, answers);
  }
  return { answers, interview };
}

function resign(
  manifest: TemplateCompositionManifest,
  mutate: (manifest: TemplateCompositionManifest) => TemplateCompositionManifest,
): TemplateCompositionManifest {
  const altered = mutate(manifest);
  return {
    ...altered,
    approvalDigest: approvalDigest(
      altered.proposed.inputDigest,
      altered.operations,
      altered.diagnostics,
      altered,
    ),
    outputDigest: outputDigest(altered.outputs),
  };
}

async function relevantBytes(root: string): Promise<ReadonlyMap<string, string | null>> {
  const paths = [
    ".oms/template-policy.json",
    ".oms/taxonomy.json",
    ".oms/types.json",
    ".obsidian/types.json",
    "Templates/note.md",
  ];
  const values = await Promise.all(paths.map(async path => {
    try {
      return [path, (await readFile(join(root, path))).toString("hex")] as const;
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [path, null] as const;
      }
      throw error;
    }
  }));
  return new Map(values);
}

async function reconcilePlan(root: string): Promise<TemplateCompositionManifest> {
  const context = await readTemplateReviewContext(root);
  const completed = completeInterview(context);
  expect(completed.interview.questions).toEqual([]);
  return buildReconcileCompositionManifest(root, {
    mode: "reconcile",
    census: context.census,
    ledgerDigest: null,
    answers: completed.answers,
    proposedPolicy: completed.interview.proposedPolicy!,
    reviewedTemplateIds: completed.interview.reviewedTemplateIds,
  });
}

async function expectReconcileSnapshotRace(root: string, mutate: () => Promise<void>): Promise<void> {
  const context = await readTemplateReviewContext(root);
  const completed = completeInterview(context);
  expect(completed.interview.questions).toEqual([]);
  let afterMutation: ReadonlyMap<string, string | null> | undefined;
  const original = reviewContextModule.readTemplateReviewContext;
  const read = vi.spyOn(reviewContextModule, "readTemplateReviewContext").mockImplementation(async vault => {
    const snapshot = await original(vault);
    await mutate();
    afterMutation = await relevantBytes(root);
    return snapshot;
  });
  try {
    await expect(buildReconcileCompositionManifest(root, {
      mode: "reconcile",
      census: context.census,
      ledgerDigest: null,
      answers: completed.answers,
      proposedPolicy: completed.interview.proposedPolicy!,
      reviewedTemplateIds: completed.interview.reviewedTemplateIds,
    })).rejects.toThrow(/TEMPLATE_RECONCILE_STALE/);
    expect(afterMutation).toBeDefined();
    expect(await relevantBytes(root)).toEqual(afterMutation);
  } finally {
    read.mockRestore();
  }
}

async function verifiedFixture(options: { readonly destinationClass?: "managed-default" | "registered-existing"; readonly richContract?: boolean } = {}): Promise<string> {
  const root = await fixture(options);
  const initial = await reconcilePlan(root);
  const applied = await executeTemplateTransaction(root, initial, { approvedDigest: initial.approvalDigest });
  if (applied.status !== "applied") throw new Error(`expected initial verified reconcile, got ${applied.status}`);
  return root;
}

describe("buildReconcileCompositionManifest", () => {
  it("plans a source-preserving reconcile with controls as the only outputs", async () => {
    const root = await fixture();
    const context = await readTemplateReviewContext(root);
    const completed = completeInterview(context);
    expect(completed.interview.questions).toEqual([]);
    const manifest = await buildReconcileCompositionManifest(root, {
      mode: "reconcile",
      census: context.census,
      ledgerDigest: null,
      answers: completed.answers,
      proposedPolicy: completed.interview.proposedPolicy!,
      reviewedTemplateIds: completed.interview.reviewedTemplateIds,
    });
    expect(manifest.mode).toBe("reconcile");
    expect(manifest.sources.every(source => source.action === "verify-only")).toBe(true);
    expect(manifest.outputs.every(output => output.finalVaultRelativePath.startsWith(".oms/"))).toBe(true);
    expect(manifest.controls.find(control => control.kind === "taxonomy")?.action).toBe("verify-only");
    expect(manifest.proposed.bindings.every(binding => binding.destinationClass === "registered-existing")).toBe(true);
  });

  it("rejects stale census and forged model policy output", async () => {
    const root = await fixture();
    const context = await readTemplateReviewContext(root);
    const completed = completeInterview(context);
    await writeFile(join(root, "Templates/note.md"), "---\ntitle: Changed\n---\nBody\n");
    await expect(buildReconcileCompositionManifest(root, {
      mode: "reconcile",
      census: context.census,
      ledgerDigest: null,
      answers: completed.answers,
      proposedPolicy: completed.interview.proposedPolicy!,
      reviewedTemplateIds: completed.interview.reviewedTemplateIds,
    })).rejects.toThrow(/TEMPLATE_RECONCILE_STALE/);

    const clean = await fixture();
    const fresh = await readTemplateReviewContext(clean);
    const model = completeInterview(fresh);
    const forged = { ...model.interview.proposedPolicy!, templates: { ...model.interview.proposedPolicy!.templates, note: { ...model.interview.proposedPolicy!.templates.note!, naming: "forged.md" } } } as TemplatePolicy;
    await expect(buildReconcileCompositionManifest(clean, {
      mode: "reconcile",
      census: fresh.census,
      ledgerDigest: null,
      answers: model.answers,
      proposedPolicy: forged,
      reviewedTemplateIds: model.interview.reviewedTemplateIds,
    })).rejects.toThrow(/TEMPLATE_RECONCILE_INVALID/);
  });

  it.each([
    ".oms/template-policy.json",
    ".oms/taxonomy.json",
    ".oms/types.json",
    ".obsidian/types.json",
  ] as const)("rejects a %s change after the reviewed context snapshot", async path => {
    const root = await fixture();
    if (path === ".oms/types.json") await writeFile(join(root, path), "{}\n");
    await expectReconcileSnapshotRace(root, async () => {
      await writeFile(join(root, path), `${await readFile(join(root, path), "utf8")}\n`);
    });
  });

  it.each([
    ".oms/template-policy.json",
    ".oms/taxonomy.json",
    ".oms/types.json",
    ".obsidian/types.json",
  ] as const)("rejects a %s removal after the reviewed context snapshot", async path => {
    const root = await fixture();
    if (path === ".oms/types.json") await writeFile(join(root, path), "{}\n");
    await expectReconcileSnapshotRace(root, async () => {
      await unlink(join(root, path));
    });
  });

  it("rejects a newly present projection after an absent reviewed snapshot", async () => {
    const root = await fixture();
    await expect(readFile(join(root, ".oms/types.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expectReconcileSnapshotRace(root, async () => {
      await writeFile(join(root, ".oms/types.json"), "{}\n");
    });
  });

  it("rejects a source edit after the reviewed context snapshot", async () => {
    const root = await fixture();
    await expectReconcileSnapshotRace(root, async () => {
      await writeFile(join(root, "Templates/note.md"), "---\ntitle: Raced\n---\nBody\n");
    });
  });

  it("rejects a source removal after the reviewed context snapshot", async () => {
    const root = await fixture();
    await expectReconcileSnapshotRace(root, async () => {
      await unlink(join(root, "Templates/note.md"));
    });
  });

  it("rejects an unbound selected-folder candidate added after C2 without publishing it", async () => {
    const root = await fixture();
    const candidate = join(root, "Templates/unbound.md");
    const candidateBytes = "---\ntitle: Unbound\n---\nCandidate\n";
    const before = await relevantBytes(root);
    await expectReconcileSnapshotRace(root, async () => {
      await writeFile(candidate, candidateBytes);
    });
    expect(await readFile(candidate, "utf8")).toBe(candidateBytes);
    expect(await relevantBytes(root)).toEqual(before);
  });

  it("wraps an unreadable follow-up review snapshot as stale", async () => {
    const root = await fixture();
    const context = await readTemplateReviewContext(root);
    const completed = completeInterview(context);
    expect(completed.interview.questions).toEqual([]);
    const original = reviewContextModule.readTemplateReviewContext;
    let reads = 0;
    const read = vi.spyOn(reviewContextModule, "readTemplateReviewContext").mockImplementation(async vault => {
      reads += 1;
      if (reads === 2) throw new Error("injected follow-up review read failure");
      return original(vault);
    });
    try {
      await expect(buildReconcileCompositionManifest(root, {
        mode: "reconcile",
        census: context.census,
        ledgerDigest: null,
        answers: completed.answers,
        proposedPolicy: completed.interview.proposedPolicy!,
        reviewedTemplateIds: completed.interview.reviewedTemplateIds,
      })).rejects.toThrow(/TEMPLATE_RECONCILE_STALE/);
      expect(reads).toBe(2);
    } finally {
      read.mockRestore();
    }
  });

  it("rejects a newly present source after an absent reviewed snapshot", async () => {
    const root = await verifiedFixture();
    await unlink(join(root, "Templates/note.md"));
    await expectReconcileSnapshotRace(root, async () => {
      await writeFile(join(root, "Templates/note.md"), "---\ntitle: Reappeared\n---\nBody\n");
    });
  });

  it("reconciles an edited source without proposing a source write", async () => {
    const root = await fixture();
    await writeFile(join(root, "Templates/note.md"), "---\ntitle: Edited\n---\nChanged body\n");
    const context = await readTemplateReviewContext(root);
    const completed = completeInterview(context);
    const manifest = await buildReconcileCompositionManifest(root, {
      mode: "reconcile",
      census: context.census,
      ledgerDigest: null,
      answers: completed.answers,
      proposedPolicy: completed.interview.proposedPolicy!,
      reviewedTemplateIds: completed.interview.reviewedTemplateIds,
    });
    expect(manifest.sources.every(source => source.action === "verify-only")).toBe(true);
    expect(manifest.outputs.every(output => output.finalVaultRelativePath === ".oms/template-policy.json" || output.finalVaultRelativePath === ".oms/types.json")).toBe(true);
  });

  it("rejects a source whose observed renderer disagrees with the policy binding", async () => {
    const root = await fixture();
    await writeFile(join(root, "Templates/note.md"), "---\ntitle: Note\n---\n<% tp.system.prompt() %>\n");
    const context = await readTemplateReviewContext(root);
    const completed = completeInterview(context);
    expect(completed.interview.diagnostics).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_SOURCE_INVALID",
      path: "Templates/note.md",
    }));
    await expect(buildReconcileCompositionManifest(root, {
      mode: "reconcile",
      census: context.census,
      ledgerDigest: null,
      answers: completed.answers,
      proposedPolicy: completed.interview.proposedPolicy ?? context.policy,
      reviewedTemplateIds: completed.interview.reviewedTemplateIds,
    })).rejects.toThrow(/TEMPLATE_RECONCILE_REVIEW_REQUIRED/);
  });

  it("does not retire a still-present source with an unsupported expression", async () => {
    const root = await fixture();
    await writeFile(join(root, "Templates/note.md"), "---\ntitle: Note\n---\n{{tp.system.run()}}\n");
    const context = await readTemplateReviewContext(root);
    const completed = completeInterview(context);
    expect(completed.interview.diagnostics).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_EXPRESSION_UNSUPPORTED",
      path: "Templates/note.md",
    }));
    await expect(buildReconcileCompositionManifest(root, {
      mode: "reconcile",
      census: context.census,
      ledgerDigest: null,
      answers: completed.answers,
      proposedPolicy: completed.interview.proposedPolicy ?? context.policy,
      reviewedTemplateIds: completed.interview.reviewedTemplateIds,
    })).rejects.toThrow(/TEMPLATE_RECONCILE_REVIEW_REQUIRED/);
  });

  it("includes both sides of a source-preserving rename", async () => {
    const root = await verifiedFixture();
    const first = await readTemplateReviewContext(root);
    const old = join(root, "Templates/note.md");
    const next = join(root, "Templates/renamed.md");
    await rename(old, next);
    const context = await readTemplateReviewContext(root);
    const completed = completeInterview(context);
    const manifest = await buildReconcileCompositionManifest(root, {
      mode: "reconcile",
      census: context.census,
      ledgerDigest: null,
      answers: completed.answers,
      proposedPolicy: completed.interview.proposedPolicy!,
      reviewedTemplateIds: completed.interview.reviewedTemplateIds,
    });
    expect(manifest.sources.some(source => source.path === "Templates/note.md" && source.current.state === "absent")).toBe(true);
    expect(manifest.sources.some(source => source.path === "Templates/renamed.md" && source.current.state === "present")).toBe(true);
    expect(first.census.entries[0]?.sourcePath).toBe("Templates/note.md");
  });

  it("represents absent retirement without source deletion", async () => {
    const root = await verifiedFixture();
    const context = await readTemplateReviewContext(root);
    await unlink(join(root, "Templates/note.md"));
    const current = await readTemplateReviewContext(root);
    const completed = completeInterview(current);
    const manifest = await buildReconcileCompositionManifest(root, {
      mode: "reconcile",
      census: current.census,
      ledgerDigest: null,
      answers: completed.answers,
      proposedPolicy: completed.interview.proposedPolicy!,
      reviewedTemplateIds: completed.interview.reviewedTemplateIds,
    });
    expect(manifest.sources.every(source => source.action === "verify-only")).toBe(true);
    expect(manifest.sources.some(source => source.current.state === "absent")).toBe(true);
    expect(context.census.entries).toHaveLength(1);
  });

  it.each(["write", "delete"] as const)("rejects a re-signed reconcile manifest with a source %s action", async action => {
    const root = await fixture();
    const manifest = await reconcilePlan(root);
    const forged = resign(manifest, value => ({
      ...value,
      sources: value.sources.map((source, index) => index === 0 ? { ...source, action } : source),
    }));
    const before = await relevantBytes(root);
    const receipt = await executeTemplateTransaction(root, forged, { approvedDigest: forged.approvalDigest });
    expect(receipt.status).toBe("rejected");
    expect(receipt.status === "rejected" ? receipt.diagnostics[0]?.code : undefined).toBe("TEMPLATE_TRANSACTION_MANIFEST_INVALID");
    expect(await relevantBytes(root)).toEqual(before);
  });

  it("rejects a re-signed verify-only source whose proposed state differs", async () => {
    const root = await fixture();
    const manifest = await reconcilePlan(root);
    const forged = resign(manifest, value => ({
      ...value,
      sources: value.sources.map((source, index) => index === 0
        ? { ...source, proposed: { state: "absent" as const } }
        : source),
    }));
    const before = await relevantBytes(root);
    const receipt = await executeTemplateTransaction(root, forged, { approvedDigest: forged.approvalDigest });
    expect(receipt.status).toBe("rejected");
    expect(receipt.status === "rejected" ? receipt.diagnostics[0]?.code : undefined).toBe("TEMPLATE_TRANSACTION_MANIFEST_INVALID");
    expect(await relevantBytes(root)).toEqual(before);
  });

  it("rejects a re-signed reconcile output outside the three OMS controls", async () => {
    const root = await fixture();
    const manifest = await reconcilePlan(root);
    const forged = resign(manifest, value => ({
      ...value,
      outputs: [...value.outputs, { finalVaultRelativePath: "Templates/forged.md" as TemplateCompositionManifest["outputs"][number]["finalVaultRelativePath"], payloadDigest: sha("forged") }],
    }));
    const before = await relevantBytes(root);
    const receipt = await executeTemplateTransaction(root, forged, { approvedDigest: forged.approvalDigest });
    expect(receipt.status).toBe("rejected");
    expect(receipt.status === "rejected" ? receipt.diagnostics[0]?.code : undefined).toBe("TEMPLATE_TRANSACTION_MANIFEST_INVALID");
    expect(await relevantBytes(root)).toEqual(before);
  });

  it("rejects a re-signed reconcile managed-rename move", async () => {
    const root = await fixture();
    const manifest = await reconcilePlan(root);
    const source = manifest.sources[0]!;
    const forged = resign(manifest, value => ({
      ...value,
      moves: [{
        templateId: source.templateId,
        strategy: "oms-managed-rename" as const,
        oldPath: source.path,
        newPath: source.path,
        sourceSignature: source.current.state === "present" ? source.current.signature : sha("absent"),
      }],
    }));
    const before = await relevantBytes(root);
    const receipt = await executeTemplateTransaction(root, forged, { approvedDigest: forged.approvalDigest });
    expect(receipt.status).toBe("rejected");
    expect(receipt.status === "rejected" ? receipt.diagnostics[0]?.code : undefined).toBe("TEMPLATE_TRANSACTION_MANIFEST_INVALID");
    expect(await relevantBytes(root)).toEqual(before);
  });

  it("rejects a no-op reconcile after its source changes instead of returning unchanged", async () => {
    const root = await fixture({ destinationClass: "registered-existing", richContract: true });
    const first = await reconcilePlan(root);
    const applied = await executeTemplateTransaction(root, first, { approvedDigest: first.approvalDigest });
    expect(applied.status).toBe("applied");

    const second = await reconcilePlan(root);
    expect(second.controls.every(control => control.action === "verify-only")).toBe(true);
    expect(second.sources.every(source => source.action === "verify-only")).toBe(true);
    const before = await relevantBytes(root);
    await writeFile(join(root, "Templates/note.md"), "---\ntitle: raced\n---\nChanged\n");
    const racedBeforeExecute = await relevantBytes(root);
    const receipt = await executeTemplateTransaction(root, second, { approvedDigest: second.approvalDigest });
    expect(receipt.status).toBe("rejected");
    expect(receipt.status === "rejected" ? receipt.diagnostics[0]?.code : undefined).toBe("MIGRATION_APPROVAL_MISMATCH");
    expect(await relevantBytes(root)).toEqual(racedBeforeExecute);
    expect(await relevantBytes(root)).not.toEqual(before);
  });
});
