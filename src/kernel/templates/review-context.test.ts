import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveContentFormatContract } from "./content-contract.js";
import { buildTemplateInterview, validateInterviewAnswer } from "./interview.js";
import { buildReconcileCompositionManifest } from "./reconcile.js";
import { deriveManagedTemplateProjection, resolveClassifiedTemplateSource, sharedAuthoritySignature, sourceSignature } from "./resolver.js";
import { parseTemplatePolicy, serializeDerivedProjection } from "./policy.js";
import { readTemplateReviewContext } from "./review-context.js";
import { executeTemplateOperation } from "./operations.js";
import { executeTemplateTransaction } from "./transaction.js";
import type { Digest, SourceDescriptor, TemplateBinding, TemplateId, TemplateSourcePath } from "./types.js";
import type { InterviewLedgerAnswer } from "./interview-ledger.js";

const capturedAuthorityRead = vi.hoisted(() => ({
  target: "",
  replacement: null as Buffer | null,
  reads: 0,
}));

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const value = await actual.readFile(...args);
      if (capturedAuthorityRead.target !== "" && String(args[0]) === capturedAuthorityRead.target) {
        capturedAuthorityRead.reads += 1;
        if (capturedAuthorityRead.reads > 1 && capturedAuthorityRead.replacement !== null) return capturedAuthorityRead.replacement;
      }
      return value;
    },
  };
});

const roots: string[] = [];
const digest = (value: string): Digest => `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;

function answerValue(question: ReturnType<typeof buildTemplateInterview>["questions"][number]): unknown {
  if (question.kind === "field-type") return "text";
  if (question.kind === "field-requiredness" || question.kind === "content-section-requiredness") return "optional";
  if (question.kind === "field-intent") return "note";
  if (question.kind === "content-order") return "unordered";
  if (question.kind === "contract-selection") return "note";
  if (question.kind === "deleted-source-disposition") return "defer";
  if (question.kind === "rename-identity") return question.choices?.[0] ?? "note";
  return "{{title}}.md";
}

function completeInterview(
  context: Awaited<ReturnType<typeof readTemplateReviewContext>>,
): { readonly answers: Readonly<Record<string, InterviewLedgerAnswer>>; readonly interview: ReturnType<typeof buildTemplateInterview>; } {
  const answers: Record<string, InterviewLedgerAnswer> = {};
  let interview = buildTemplateInterview(context, answers);
  for (let pass = 0; pass < 256 && interview.next !== undefined; pass += 1) {
    const question = interview.next;
    answers[question.questionId] = validateInterviewAnswer(question, answerValue(question));
    interview = buildTemplateInterview(context, answers);
  }
  return { answers, interview };
}

afterEach(async () => {
  capturedAuthorityRead.target = "";
  capturedAuthorityRead.replacement = null;
  capturedAuthorityRead.reads = 0;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(
  second = false,
  options: { readonly approved?: boolean; readonly destinationClass?: "managed-default" | "registered-existing" } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-review-context-"));
  roots.push(root);
  await mkdir(join(root, ".oms"), { recursive: true });
  await mkdir(join(root, ".obsidian"), { recursive: true });
  await mkdir(join(root, "Templates"), { recursive: true });
  const source = "---\ntitle: Note\n---\nBody\n";
  const reference = "---\ntitle: Reference\n---\nReference body\n";
  const policyValue = {
    version: 3,
    templateFolders: [{ path: "Templates", default: true }],
    base: { fields: {} },
    contracts: { note: { intent: "Notes", fields: {}, views: [] } },
    templates: {
      note: {
        templateId: "note",
        destinationClass: options.destinationClass ?? "managed-default",
        renderer: "obsidian-core",
        sourceFolder: "Templates",
        sourcePath: "Templates/note.md",
        contract: "note",
        naming: "{{title}}.md",
        ...(options.approved ? { approvedSourceSignature: digest(source) } : {}),
      },
      ...(second ? {
        reference: {
          templateId: "reference",
          destinationClass: "managed-default",
          renderer: "obsidian-core",
          sourceFolder: "Templates",
          sourcePath: "Templates/reference.md",
          contract: "note",
          naming: "{{title}}.md",
        },
      } : {}),
    },
  };
  const policy = parseTemplatePolicy(policyValue);
  const taxonomy = JSON.stringify({ folders: {} });
  const obsidian = JSON.stringify({ types: { title: "text" } });
  await Promise.all([
    writeFile(join(root, ".oms/template-policy.json"), JSON.stringify(policyValue)),
    writeFile(join(root, ".oms/taxonomy.json"), taxonomy),
    writeFile(join(root, ".obsidian/types.json"), obsidian),
    writeFile(join(root, "Templates/note.md"), source),
    ...(second ? [writeFile(join(root, "Templates/reference.md"), reference)] : []),
  ]);
  const bindings = Object.values(policy.templates);
  const controls: SourceDescriptor[] = [
    { logicalId: "template-policy", signature: digest(JSON.stringify(policyValue)) },
    { logicalId: "taxonomy", signature: digest(taxonomy) },
    { logicalId: "obsidian-types", signature: digest(obsidian) },
  ];
  const sourceDescriptors = [
    ...controls,
    { path: "Templates/note.md", signature: digest(source) },
    ...(second ? [{ path: "Templates/reference.md", signature: digest(reference) }] : []),
  ];
  const managed = Object.fromEntries(bindings.map(binding => {
    const bytes = binding.templateId === "note" ? source : reference;
    const classified = resolveClassifiedTemplateSource(binding.sourcePath, new TextEncoder().encode(bytes), binding.renderer);
    const content = deriveContentFormatContract(classified.body, { templateId: binding.templateId }).contract;
    const projected = deriveManagedTemplateProjection(policy, binding, classified, { title: "text" });
    return [binding.templateId, { ...projected, content }];
  }));
  const projection = {
    version: "oms.types.v1" as const,
    generatedFrom: {
      algorithm: "sha256-lp-v1" as const,
      inputSignature: sourceSignature(sourceDescriptors),
      sharedAuthoritySignature: sharedAuthoritySignature(controls),
      sources: sourceDescriptors,
    },
    managed: { base: policy.base, templates: managed, globalAxes: {} },
  };
  await writeFile(join(root, ".oms/types.json"), serializeDerivedProjection(projection));
  return root;
}

async function sourceAuthoringFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-review-authoring-"));
  roots.push(root);
  await mkdir(join(root, ".oms"), { recursive: true });
  await mkdir(join(root, ".obsidian"), { recursive: true });
  await mkdir(join(root, "Templates"), { recursive: true });
  const policyValue = {
    version: 3,
    templateFolders: [{ path: "Templates", default: true }],
    base: { fields: {} },
    contracts: { note: { intent: "Notes", fields: {}, views: [] } },
    templates: {},
  };
  const taxonomy = JSON.stringify({ folders: {} });
  const obsidian = JSON.stringify({ types: { title: "text" } });
  const policy = parseTemplatePolicy(policyValue);
  const controls: SourceDescriptor[] = [
    { logicalId: "template-policy", signature: digest(JSON.stringify(policyValue)) },
    { logicalId: "taxonomy", signature: digest(taxonomy) },
    { logicalId: "obsidian-types", signature: digest(obsidian) },
  ];
  await Promise.all([
    writeFile(join(root, ".oms/template-policy.json"), JSON.stringify(policyValue)),
    writeFile(join(root, ".oms/taxonomy.json"), taxonomy),
    writeFile(join(root, ".obsidian/types.json"), obsidian),
    writeFile(join(root, ".oms/types.json"), serializeDerivedProjection({
      version: "oms.types.v1",
      generatedFrom: {
        algorithm: "sha256-lp-v1",
        inputSignature: sourceSignature(controls),
        sharedAuthoritySignature: sharedAuthoritySignature(controls),
        sources: controls,
      },
      managed: { base: policy.base, templates: {}, globalAxes: {} },
    })),
  ]);
  return root;
}

describe("readTemplateReviewContext", () => {
  it("returns a valid no-change context with fresh IDs and policy semantics", async () => {
    const root = await fixture();
    const before = await readFile(join(root, ".oms/template-policy.json"));
    const context = await readTemplateReviewContext(root);
    expect(context.vault).toBe(await realpath(root));
    expect(context.policy.defaultTemplate).toBeUndefined();
    expect(context.obsidianTypes).toEqual({ title: "text" });
    expect(context.authorityStates).toEqual({
      ".oms/template-policy.json": { state: "present", signature: digest(await readFile(join(root, ".oms/template-policy.json"), "utf8")) },
      ".oms/taxonomy.json": { state: "present", signature: digest(await readFile(join(root, ".oms/taxonomy.json"), "utf8")) },
      ".oms/types.json": { state: "present", signature: digest(await readFile(join(root, ".oms/types.json"), "utf8")) },
      ".obsidian/types.json": { state: "present", signature: digest(await readFile(join(root, ".obsidian/types.json"), "utf8")) },
    });
    expect(context.projectionUsable).toBe(true);
    expect(context.freshTemplateIds).toEqual(["note"]);
    expect(context.census.diffs).toEqual([]);
    expect(buildTemplateInterview(context, {}).proposedPolicy?.templates.note?.approvedBodySignature).toBe(digest("Body\n"));
    expect(await readFile(join(root, ".oms/template-policy.json"))).toEqual(before);
  });

  it("parses captured Obsidian authority bytes without a second potentially changed read", async () => {
    const root = await fixture();
    const original = await readFile(join(root, ".obsidian/types.json"), "utf8");
    capturedAuthorityRead.target = join(await realpath(root), ".obsidian/types.json");
    capturedAuthorityRead.replacement = Buffer.from(JSON.stringify({ types: { title: "number" } }));

    const context = await readTemplateReviewContext(root);

    expect(capturedAuthorityRead.reads).toBe(1);
    expect(context.obsidianTypes).toEqual({ title: "text" });
    expect(context.authorityStates[".obsidian/types.json"]).toEqual({ state: "present", signature: digest(original) });
  });

  it("enters review with missing, invalid, or tampered derived projection bytes", async () => {
    const root = await fixture();
    await unlink(join(root, ".oms/types.json"));
    const missing = await readTemplateReviewContext(root);
    expect(missing.projectionUsable).toBe(false);
    expect(missing.freshTemplateIds).toEqual([]);
    expect(missing.census.diffs).toEqual([expect.objectContaining({ kind: "added", sourcePath: "Templates/note.md" })]);

    await writeFile(join(root, ".oms/types.json"), "{not-json");
    const invalid = await readTemplateReviewContext(root);
    expect(invalid.projectionUsable).toBe(false);
    expect(invalid.freshTemplateIds).toEqual([]);

    const tamperedRoot = await fixture();
    const projection = JSON.parse(await readFile(join(tamperedRoot, ".oms/types.json"), "utf8")) as Record<string, unknown>;
    projection.managed = { base: { fields: { tampered: { type: "text" } } }, templates: {}, globalAxes: {} };
    await writeFile(join(tamperedRoot, ".oms/types.json"), JSON.stringify(projection));
    const tampered = await readTemplateReviewContext(tamperedRoot);
    expect(tampered.projectionUsable).toBe(false);
  });

  it("emits missing-bound deletion evidence and a disposition question without a projection", async () => {
    const root = await fixture();
    await unlink(join(root, "Templates/note.md"));
    await unlink(join(root, ".oms/types.json"));

    const context = await readTemplateReviewContext(root);

    expect(context.projectionUsable).toBe(false);
    expect(context.census.diffs).toEqual([expect.objectContaining({
      kind: "deleted",
      sourcePath: "Templates/note.md",
      templateId: "note",
    })]);
    expect(buildTemplateInterview(context, {}).questions).toEqual([
      expect.objectContaining({
        kind: "deleted-source-disposition",
        templateId: "note",
      }),
    ]);
  });

  it("retains a policy-approved source signature for a bootstrap exact-byte move", async () => {
    const root = await fixture(false, { approved: true });
    await unlink(join(root, "Templates/note.md"));
    await unlink(join(root, ".oms/types.json"));
    await writeFile(join(root, "Templates/moved.md"), "---\ntitle: Note\n---\nBody\n");

    const context = await readTemplateReviewContext(root);

    expect(context.census.diffs).toEqual([expect.objectContaining({
      kind: "renamed",
      oldSourcePath: "Templates/note.md",
      newSourcePath: "Templates/moved.md",
      templateId: "note",
      automatic: true,
      confirmationRequired: false,
      strategy: "identical-bytes",
    })]);
  });

  it("keeps a bootstrap move confirmation-only when no approved historical bytes exist", async () => {
    const root = await fixture();
    await unlink(join(root, "Templates/note.md"));
    await unlink(join(root, ".oms/types.json"));
    await writeFile(join(root, "Templates/moved.md"), "---\ntitle: Changed\n---\nMoved body\n");

    const context = await readTemplateReviewContext(root);
    const interview = buildTemplateInterview(context, {});

    expect(context.census.diffs).toEqual([expect.objectContaining({
      kind: "renamed",
      oldSourcePath: "Templates/note.md",
      newSourcePath: "Templates/moved.md",
      automatic: false,
      confirmationRequired: true,
      strategy: "lone-delete-add",
    })]);
    expect(interview.questions).toContainEqual(expect.objectContaining({
      kind: "rename-identity",
      subject: "rename:Templates/note.md->Templates/moved.md",
    }));
    expect(interview.diagnostics).not.toContainEqual(expect.objectContaining({ code: "TEMPLATE_ID_DUPLICATE" }));
  });

  it("does not auto-transfer identity from a forged projection descriptor", async () => {
    const root = await fixture();
    const moved = "---\ntitle: Forged\n---\nMoved body\n";
    const projection = JSON.parse(await readFile(join(root, ".oms/types.json"), "utf8")) as {
      generatedFrom: {
        inputSignature: Digest;
        sources: Array<{ readonly path?: string; signature: Digest; readonly logicalId?: string }>;
      };
    };
    const descriptor = projection.generatedFrom.sources.find(source => source.path === "Templates/note.md");
    if (descriptor === undefined) throw new Error("expected note path descriptor");
    descriptor.signature = digest(moved);
    projection.generatedFrom.inputSignature = sourceSignature(projection.generatedFrom.sources);
    await writeFile(join(root, ".oms/types.json"), JSON.stringify(projection));
    await unlink(join(root, "Templates/note.md"));
    await writeFile(join(root, "Templates/moved.md"), moved);

    const context = await readTemplateReviewContext(root);

    expect(context.census.diffs).toEqual([expect.objectContaining({
      kind: "renamed",
      oldSourcePath: "Templates/note.md",
      newSourcePath: "Templates/moved.md",
      automatic: false,
      confirmationRequired: true,
      strategy: "lone-delete-add",
    })]);
    expect(context.census.diffs).not.toContainEqual(expect.objectContaining({
      strategy: "identical-bytes",
      automatic: true,
    }));
    expect(context.census.entries[0]?.templateId).toBe("moved");
  });

  it("keeps a deferred absent binding visible after controls-only publication", async () => {
    const root = await fixture(false, { destinationClass: "registered-existing" });
    await unlink(join(root, "Templates/note.md"));
    const context = await readTemplateReviewContext(root);
    const completed = completeInterview(context);
    expect(completed.interview.questions).toHaveLength(0);
    expect(completed.interview.proposedPolicy?.templates.note).toBeDefined();

    const manifest = await buildReconcileCompositionManifest(root, {
      mode: "reconcile",
      census: context.census,
      ledgerDigest: null,
      answers: completed.answers,
      proposedPolicy: completed.interview.proposedPolicy!,
      reviewedTemplateIds: completed.interview.reviewedTemplateIds,
    });
    const receipt = await executeTemplateTransaction(root, manifest, { approvedDigest: manifest.approvalDigest });
    expect(receipt.status).toBe("applied");

    const published = await readTemplateReviewContext(root);
    expect(published.policy.templates.note).toBeDefined();
    expect(published.census.diffs).toContainEqual(expect.objectContaining({
      kind: "deleted",
      sourcePath: "Templates/note.md",
      templateId: "note",
    }));
    expect(buildTemplateInterview(published, {}).questions).toContainEqual(expect.objectContaining({
      kind: "deleted-source-disposition",
      templateId: "note",
    }));
  });

  it("keeps an edited source pending while preserving an unchanged sibling", async () => {
    const root = await fixture(true);
    await writeFile(join(root, "Templates/note.md"), "---\ntitle: Changed\n---\nBody\n");
    const context = await readTemplateReviewContext(root);
    expect(context.projectionUsable).toBe(true);
    expect(context.freshTemplateIds).toEqual(["reference"]);
    expect(context.census.diffs).toContainEqual(expect.objectContaining({ kind: "edited", sourcePath: "Templates/note.md" }));
    expect(context.census.diffs).not.toContainEqual(expect.objectContaining({ kind: "edited", sourcePath: "Templates/reference.md" }));
  });

  it("invalidates the projection context on control changes but never writes controls", async () => {
    const root = await fixture();
    const before = await readFile(join(root, ".oms/types.json"));
    const policyPath = join(root, ".oms/template-policy.json");
    await writeFile(policyPath, `${await readFile(policyPath, "utf8")}\n`);
    const context = await readTemplateReviewContext(root);
    expect(context.projectionUsable).toBe(false);
    expect(await readFile(join(root, ".oms/types.json"))).toEqual(before);
  });

  it("does not carry identity from a mismatched managed projection path", async () => {
    const root = await fixture();
    const projection = JSON.parse(await readFile(join(root, ".oms/types.json"), "utf8")) as {
      managed: { templates: Record<string, { sourcePath: string }> };
    };
    projection.managed.templates.note!.sourcePath = "Templates/renamed.md";
    await writeFile(join(root, ".oms/types.json"), JSON.stringify(projection));
    const context = await readTemplateReviewContext(root);
    expect(context.projectionUsable).toBe(false);
    expect(context.freshTemplateIds).toEqual([]);
  });

  it("retains independent body proof across explicit authoring and restart-shaped body-only moves", async () => {
    const root = await sourceAuthoringFixture();
    const first = "---\ntitle: First\n---\n# First body\n";
    const second = "---\ntitle: Second\n---\n# Second body\n";
    const author = async (templateId: string, source: string): Promise<void> => {
      const id = templateId as TemplateId;
      const sourcePath = `Templates/${templateId}.md` as TemplateSourcePath;
      const binding: TemplateBinding = {
        templateId: id,
        destinationClass: "registered-existing",
        renderer: "obsidian-core",
        sourceFolder: "Templates" as TemplateBinding["sourceFolder"],
        sourcePath,
        contract: "note",
        naming: "{{title}}.md",
      };
      const change = {
        mode: "create" as const,
        binding,
        source: { path: sourcePath, bytes: new TextEncoder().encode(source), publication: "write" as const },
      };
      const planned = await executeTemplateOperation({ vault: root, source: "explicit" }, change, { dryRun: true });
      expect(planned.status).toBe("planned");
      if (planned.status !== "planned") throw new Error("expected source-authoring plan");
      const applied = await executeTemplateOperation(
        { vault: root, source: "explicit" },
        change,
        { approvedDigest: planned.approvalDigest },
      );
      expect(applied.status).toBe("applied");
    };
    await author("first", first);
    await author("second", second);

    const persisted = JSON.parse(await readFile(join(root, ".oms/template-policy.json"), "utf8")) as {
      templates: Record<string, {
        approvedSourceSignature?: string;
        approvedBodySignature?: string;
        content?: unknown;
      }>;
    };
    expect(persisted.templates.first).toMatchObject({
      approvedSourceSignature: digest(first),
      approvedBodySignature: digest("# First body\n"),
    });
    expect(persisted.templates.first?.content).toBeUndefined();
    expect(persisted.templates.second).toMatchObject({
      approvedSourceSignature: digest(second),
      approvedBodySignature: digest("# Second body\n"),
    });
    expect(persisted.templates.second?.content).toBeUndefined();

    await rename(join(root, "Templates/first.md"), join(root, "Templates/first-moved.md"));
    await rename(join(root, "Templates/second.md"), join(root, "Templates/second-moved.md"));
    const firstMoved = "---\ntitle: Moved First\n---\n# First body\n";
    const secondMoved = "---\ntitle: Moved Second\n---\n# Second body\n";
    await writeFile(join(root, "Templates/first-moved.md"), firstMoved);
    await writeFile(join(root, "Templates/second-moved.md"), secondMoved);

    const context = await readTemplateReviewContext(root);
    expect(context.census.diffs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        oldSourcePath: "Templates/first.md",
        newSourcePath: "Templates/first-moved.md",
        strategy: "body-signature",
        automatic: false,
        confirmationRequired: true,
      }),
      expect.objectContaining({
        oldSourcePath: "Templates/second.md",
        newSourcePath: "Templates/second-moved.md",
        strategy: "body-signature",
        automatic: false,
        confirmationRequired: true,
      }),
    ]));
    expect(context.census.diffs).toHaveLength(2);
    const interview = buildTemplateInterview(context, {});
    const renameQuestions = interview.questions.filter(question => question.kind === "rename-identity");
    expect(renameQuestions).toHaveLength(2);
    expect(renameQuestions.map(question => question.subject)).toEqual(expect.arrayContaining([
      "rename:Templates/first.md->Templates/first-moved.md",
      "rename:Templates/second.md->Templates/second-moved.md",
    ]));
    expect(context.census.diffs.every(diff => !diff.automatic)).toBe(true);
    expect(context.census.entries.map(entry => entry.templateId)).not.toContain("first");
    expect(context.census.entries.map(entry => entry.templateId)).not.toContain("second");
    expect(persisted.templates.first?.approvedSourceSignature).not.toBe(digest(firstMoved));
    expect(persisted.templates.second?.approvedSourceSignature).not.toBe(digest(secondMoved));
  });
});
