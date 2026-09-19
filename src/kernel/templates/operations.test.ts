import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { inputDigest, templateInput } from "./canonical.js";
import { deriveContentFormatContract } from "./content-contract.js";
import { buildTemplateInterview, validateInterviewAnswer, type TemplateInterview } from "./interview.js";
import type { InterviewLedgerAnswer } from "./interview-ledger.js";
import { readTemplateReviewContext } from "./review-context.js";
import { executeTemplateOperation } from "./operations.js";
import { normalizeTemplateSemanticChange, parseTemplatePolicy } from "./policy.js";
import { buildTemplateCompositionManifest, loadResolvedTemplates, sharedAuthoritySignature, sourceSignature, taxonomyRouting } from "./resolver.js";
import { executeTemplateTransaction } from "./transaction.js";
import type { DerivedProjection, Digest, GuardedTemplateRequest, TemplateBinding, TemplateCompositionOptions, TemplateFolderPath, TemplateId, TemplatePolicy, TemplateSourcePath } from "./types.js";

const roots: string[] = [];
const sha = (value: string): Digest => `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;
const sourceProofRead = vi.hoisted(() => ({
  target: "",
  stable: null as Uint8Array | null,
  transient: null as Uint8Array | null,
  reads: 0,
}));

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (
        sourceProofRead.target !== ""
        && String(args[0]) === sourceProofRead.target
        && new Error().stack?.includes("authorSourceSignature")
      ) {
        sourceProofRead.reads += 1;
        if (sourceProofRead.transient !== null && sourceProofRead.stable !== null) {
          await actual.writeFile(sourceProofRead.target, sourceProofRead.transient);
          const captured = await actual.readFile(...args);
          await actual.writeFile(sourceProofRead.target, sourceProofRead.stable);
          return captured;
        }
      }
      return actual.readFile(...args);
    },
  };
});

async function fixture(): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), "oms-template-operation-"));
  roots.push(vault);
  await Promise.all([mkdir(join(vault, ".oms")), mkdir(join(vault, ".obsidian")), mkdir(join(vault, "Templates"))]);
  const taxonomy = JSON.stringify({ templates: { note: { templateFolder: "notes" } } });
  const obsidian = JSON.stringify({ types: { title: "text" } });
  const template = "---\ntitle: note\n---\nbody\n";
  const policy = JSON.stringify({ version: 3, templateFolders: [{ path: "Templates", default: true }], defaultTemplate: "note", base: { fields: {} }, contracts: { note: { intent: "note", fields: { title: { type: "text" } }, views: [] } }, templates: { note: { templateId: "note", destinationClass: "registered-existing", renderer: "obsidian-core", sourceFolder: "Templates", sourcePath: "Templates/note.md", contract: "note", naming: "{{slug}}.md" } } });
  const sources = [{ logicalId: "template-policy", signature: sha(policy) }, { logicalId: "taxonomy", signature: sha(taxonomy) }, { logicalId: "obsidian-types", signature: sha(obsidian) }, { path: "Templates/note.md", signature: sha(template) }];
  const content = deriveContentFormatContract("body\n", { templateId: "note", finalNewline: true }).contract;
  const projection = JSON.stringify({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sources), sharedAuthoritySignature: sharedAuthoritySignature(sources), sources }, managed: { base: { fields: {} }, globalAxes: {}, templates: { note: { templateId: "note", destinationClass: "registered-existing", renderer: "obsidian-core", sourcePath: "Templates/note.md", targetFolder: "notes", keyOrder: ["title"], fields: { title: { type: "text" } }, views: [], naming: "{{slug}}.md", bodySignature: sha("body\n"), content } } } });
  await Promise.all([
    writeFile(join(vault, ".oms/template-policy.json"), policy),
    writeFile(join(vault, ".oms/taxonomy.json"), taxonomy),
    writeFile(join(vault, ".oms/types.json"), projection),
    writeFile(join(vault, ".obsidian/types.json"), obsidian),
    writeFile(join(vault, "Templates/note.md"), template),
  ]);
  return vault;
}

async function unicodeFixture(): Promise<{
  readonly vault: string;
  readonly id: TemplateId;
  readonly nfdId: TemplateId;
  readonly sourcePath: TemplateSourcePath;
  readonly options: TemplateCompositionOptions;
}> {
  const vault = await mkdtemp(join(tmpdir(), "oms-template-operation-unicode-"));
  roots.push(vault);
  await Promise.all([mkdir(join(vault, ".oms")), mkdir(join(vault, ".obsidian")), mkdir(join(vault, "Templates"))]);
  const id = "메모".normalize("NFC") as TemplateId;
  const nfdId = id.normalize("NFD") as TemplateId;
  const sourcePath = `Templates/${id}.md` as TemplateSourcePath;
  const taxonomy = JSON.stringify({
    templates: { [nfdId]: { templateFolder: "Preserved" } },
    folders: { Preserved: { templates: [nfdId] } },
  });
  const obsidian = JSON.stringify({ types: { title: "text" } });
  const oldBytes = new Uint8Array(Buffer.from("---\ntitle: Old\n---\nBody\n"));
  const binding: TemplateBinding = {
    templateId: id,
    destinationClass: "registered-existing",
    renderer: "obsidian-core",
    sourceFolder: "Templates" as TemplateBinding["sourceFolder"],
    sourcePath,
    contract: "note",
    naming: "{{title}}.md",
  };
  const policy = JSON.stringify({
    version: 3,
    templateFolders: [{ path: "Templates", default: true }],
    defaultTemplate: id,
    base: { fields: {} },
    contracts: { note: { intent: "note", fields: { title: { type: "text" } }, views: [] } },
    templates: { [id]: binding },
  });
  const sources = [
    { logicalId: "template-policy", signature: sha(policy) },
    { logicalId: "taxonomy", signature: sha(taxonomy) },
    { logicalId: "obsidian-types", signature: sha(obsidian) },
    { path: sourcePath, signature: sha(Buffer.from(oldBytes).toString("utf8")) },
  ];
  const content = deriveContentFormatContract("Body\n", { templateId: id, finalNewline: true }).contract;
  const projection = JSON.stringify({
    version: "oms.types.v1",
    generatedFrom: {
      algorithm: "sha256-lp-v1",
      inputSignature: sourceSignature(sources),
      sharedAuthoritySignature: sharedAuthoritySignature(sources),
      sources,
    },
    managed: {
      base: { fields: {} },
      globalAxes: {},
      templates: {
        [id]: {
          templateId: id,
          destinationClass: binding.destinationClass,
          renderer: binding.renderer,
          sourcePath,
          targetFolder: "Preserved",
          keyOrder: ["title"],
          fields: { title: { type: "text" } },
          views: [],
          naming: binding.naming,
          bodySignature: sha("Body\n"),
          content,
        },
      },
    },
  });
  await Promise.all([
    writeFile(join(vault, ".oms/template-policy.json"), policy),
    writeFile(join(vault, ".oms/taxonomy.json"), taxonomy),
    writeFile(join(vault, ".oms/types.json"), projection),
    writeFile(join(vault, ".obsidian/types.json"), obsidian),
    writeFile(join(vault, sourcePath), oldBytes),
  ]);
  const parsed = parseTemplatePolicy(policy);
  const options: TemplateCompositionOptions = {
    expected: {
      input: inputDigest(
        templateInput(
          parsed,
          { policy: sha(policy), taxonomy: sha(taxonomy), obsidianTypes: sha(obsidian), obsidianTypesPath: ".obsidian/types.json" },
          Object.values(parsed.templates),
          () => sha(Buffer.from(oldBytes).toString("utf8")),
        ),
      ),
      controls: {
        policy: { state: "present", signature: sha(policy) },
        taxonomy: { state: "present", signature: sha(taxonomy) },
        projection: { state: "present", signature: sha(projection) },
      },
      sources: [{ templateId: id, path: sourcePath, expected: { state: "present", signature: sha(Buffer.from(oldBytes).toString("utf8")) } }],
    },
    taxonomy: {
      expectedCurrent: { state: "present", signature: sha(taxonomy) },
      proposedBytes: new Uint8Array(Buffer.from(taxonomy)),
      action: "verify-only",
    },
  };
  return { vault, id, nfdId, sourcePath, options };
}

afterEach(async () => {
  sourceProofRead.target = "";
  sourceProofRead.stable = null;
  sourceProofRead.transient = null;
  sourceProofRead.reads = 0;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function answerFor(question: TemplateInterview["questions"][number]): unknown {
  if (question.kind === "field-type") return "text";
  if (question.kind === "field-requiredness" || question.kind === "content-section-requiredness") return "optional";
  if (question.kind === "field-intent") return "note";
  if (question.kind === "content-order") return "unordered";
  if (question.kind === "contract-selection") return "note";
  if (question.kind === "deleted-source-disposition") return "defer";
  if (question.kind === "rename-identity") return question.choices?.[0] ?? "note";
  return "{{title}}.md";
}

async function completeInterview(vault: string): Promise<{
  readonly context: Awaited<ReturnType<typeof readTemplateReviewContext>>;
  readonly answers: Readonly<Record<string, InterviewLedgerAnswer>>;
  readonly proposedPolicy: NonNullable<ReturnType<typeof buildTemplateInterview>["proposedPolicy"]>;
  readonly reviewedTemplateIds: readonly TemplateId[];
}> {
  const context = await readTemplateReviewContext(vault);
  const answers: Record<string, InterviewLedgerAnswer> = {};
  let result = buildTemplateInterview(context, answers);
  for (let pass = 0; pass < 8 && result.questions.length > 0; pass += 1) {
    for (const question of result.questions) answers[question.questionId] = validateInterviewAnswer(question, answerFor(question));
    result = buildTemplateInterview(context, answers);
  }
  if (result.questions.length > 0 || result.proposedPolicy === undefined) throw new Error("test interview did not resolve");
  return { context, answers, proposedPolicy: result.proposedPolicy, reviewedTemplateIds: result.reviewedTemplateIds };
}

describe("executeTemplateOperation", () => {
  it("does not ignore a selected folder that cannot be scanned as a directory", async () => {
    const vault = await fixture();
    const policyPath = join(vault, ".oms/template-policy.json");
    const projectionPath = join(vault, ".oms/types.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as TemplatePolicy;
    const projection = JSON.parse(await readFile(projectionPath, "utf8")) as DerivedProjection;
    const policyText = JSON.stringify({
      ...policy,
      templateFolders: [...policy.templateFolders, { path: "Broken" }],
    });
    const sources = projection.generatedFrom.sources.map(source =>
      source.logicalId === "template-policy" ? { ...source, signature: sha(policyText) } : source,
    );
    await Promise.all([
      writeFile(join(vault, "Broken"), "not a directory"),
      writeFile(policyPath, policyText),
      writeFile(projectionPath, JSON.stringify({
        ...projection,
        generatedFrom: {
          ...projection.generatedFrom,
          sources,
          inputSignature: sourceSignature(sources),
          sharedAuthoritySignature: sharedAuthoritySignature(sources),
        },
      })),
    ]);
    const review = await readTemplateReviewContext(vault);
    expect(review.census.diagnostics).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_FOLDER_INVALID",
      path: "Broken",
    }));
    const paths = [policyPath, projectionPath, join(vault, ".oms/taxonomy.json"), join(vault, "Templates/note.md")];
    const before = await Promise.all(paths.map(path => readFile(path)));
    await expect(executeTemplateOperation(
      { vault, source: "explicit" },
      { mode: "register-folder", folder: { path: "More" as TemplateFolderPath } },
      { dryRun: true },
    )).rejects.toThrow("TEMPLATE_REVIEW_REQUIRED");
    expect(await Promise.all(paths.map(path => readFile(path)))).toEqual(before);
  });

  it("derives CAS server-side and rejects an approval after authority drift", async () => {
    const vault = await fixture();
    const change = { mode: "register-folder" as const, folder: { path: "More" as never } };
    const planned = await executeTemplateOperation({ vault, source: "explicit" }, change, { dryRun: true });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") throw new Error("expected plan");
    const policyPath = join(vault, ".oms/template-policy.json");
    await writeFile(policyPath, `${await readFile(policyPath, "utf8")}\n`);
    const before = await Promise.all([readFile(policyPath), readFile(join(vault, ".oms/types.json"))]);
    await expect(executeTemplateOperation({ vault, source: "explicit" }, change, { approvedDigest: planned.approvalDigest })).rejects.toThrow("TEMPLATE_SOURCE_DRIFT");
    expect(await Promise.all([readFile(policyPath), readFile(join(vault, ".oms/types.json"))])).toEqual(before);
  });

  it("requires a dry-run or exact approval at the kernel boundary", async () => {
    const vault = await fixture();
    await expect(executeTemplateOperation(
      { vault, source: "explicit" },
      { mode: "default", templateId: "note" as TemplateId },
      {} as GuardedTemplateRequest,
    )).rejects.toThrow();
  });

  it("rejects a symlinked registered source before composition without publishing controls", async () => {
    const vault = await fixture();
    const policyPath = join(vault, ".oms/template-policy.json");
    const projectionPath = join(vault, ".oms/types.json");
    const before = await Promise.all([readFile(policyPath), readFile(projectionPath)]);
    await rename(join(vault, "Templates/note.md"), join(vault, "Templates/real.md"));
    await symlink("real.md", join(vault, "Templates/note.md"));

    await expect(executeTemplateOperation(
      { vault, source: "explicit" },
      { mode: "default", templateId: "note" as TemplateId },
      { dryRun: true },
    )).rejects.toThrow(/TEMPLATE_SOURCE_UNSAFE/u);
    expect(await Promise.all([readFile(policyPath), readFile(projectionPath)])).toEqual(before);
  });

  it("rejects oversized template bytes before composition", async () => {
    const vault = await fixture();
    await writeFile(join(vault, "Templates/note.md"), new Uint8Array(262_145));
    await expect(executeTemplateOperation(
      { vault, source: "explicit" },
      { mode: "default", templateId: "note" as TemplateId },
      { dryRun: true },
    )).rejects.toThrow(/TEMPLATE_PROPOSAL_OVERSIZE/u);
  });

  it("rejects guarded sibling operations while a source edit is pending", async () => {
    const vault = await fixture();
    await writeFile(join(vault, "Templates/other.md"), "---\ntitle: other\n---\nbody\n");
    const before = await Promise.all([
      readFile(join(vault, ".oms/template-policy.json")),
      readFile(join(vault, ".oms/types.json")),
    ]);
    await expect(executeTemplateOperation(
      { vault, source: "explicit" },
      { mode: "register-folder", folder: { path: "More" as never } },
      { dryRun: true },
    )).rejects.toThrow(/TEMPLATE_REVIEW_REQUIRED/u);
    await expect(executeTemplateOperation(
      { vault, source: "explicit" },
      { mode: "default", templateId: "note" as TemplateId },
      { dryRun: true },
    )).rejects.toThrow(/TEMPLATE_REVIEW_REQUIRED/u);
    expect(await Promise.all([
      readFile(join(vault, ".oms/template-policy.json")),
      readFile(join(vault, ".oms/types.json")),
    ])).toEqual(before);
  });

  it("keeps current-source tampering pending when a projection descriptor is forged", async () => {
    const vault = await fixture();
    const policyPath = join(vault, ".oms/template-policy.json");
    const original = await readFile(join(vault, "Templates/note.md"), "utf8");
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as {
      templates: { note: Record<string, unknown> };
    };
    policy.templates.note.approvedSourceSignature = sha(original);
    const policyBytes = JSON.stringify(policy);
    await writeFile(policyPath, policyBytes);
    const tampered = "---\ntitle: note\n---\ntampered body\n";
    const sourcePath = join(vault, "Templates/note.md");
    const projectionPath = join(vault, ".oms/types.json");
    await writeFile(sourcePath, tampered);
    const projection = JSON.parse(await readFile(projectionPath, "utf8")) as {
      generatedFrom: {
        inputSignature: Digest;
        sharedAuthoritySignature: Digest;
        sources: Array<{ readonly path?: string; readonly logicalId?: string; signature: Digest }>;
      };
    };
    projection.generatedFrom.sources = projection.generatedFrom.sources.map(source =>
      source.logicalId === "template-policy"
        ? { ...source, signature: sha(policyBytes) }
        : source.path === "Templates/note.md"
          ? { ...source, signature: sha(tampered) }
          : source,
    );
    projection.generatedFrom.sharedAuthoritySignature = sharedAuthoritySignature(projection.generatedFrom.sources);
    projection.generatedFrom.inputSignature = sourceSignature(projection.generatedFrom.sources);
    await writeFile(projectionPath, JSON.stringify(projection));

    const resolved = await loadResolvedTemplates(vault);
    expect(resolved.pending.note).toMatchObject({ kind: "edited", path: "Templates/note.md" });
    expect((await readTemplateReviewContext(vault)).census.diffs).toContainEqual(expect.objectContaining({
      kind: "edited",
      sourcePath: "Templates/note.md",
    }));
    await expect(executeTemplateOperation(
      { vault, source: "explicit" },
      { mode: "default", templateId: "note" as TemplateId },
      { dryRun: true },
    )).rejects.toThrow(/TEMPLATE_REVIEW_REQUIRED/u);
  });

  it("allows an explicit target update and stamps the authored source bytes", async () => {
    const vault = await fixture();
    const sourcePath = join(vault, "Templates/note.md");
    const sourceBytes = new Uint8Array(Buffer.from("---\ntitle: changed\n---\nnew body\n"));
    await writeFile(sourcePath, sourceBytes);
    const change = {
      mode: "update" as const,
      templateId: "note" as TemplateId,
      binding: {
        templateId: "note" as TemplateId,
        destinationClass: "registered-existing" as const,
        renderer: "obsidian-core" as const,
        sourceFolder: "Templates" as TemplateBinding["sourceFolder"],
        sourcePath: "Templates/note.md" as TemplateSourcePath,
        contract: "note",
        naming: "{{slug}}.md",
        approvedSourceSignature: sha("caller-claimed-stamp"),
      },
      source: {
        path: "Templates/note.md" as TemplateSourcePath,
        bytes: sourceBytes,
        publication: "write" as const,
      },
    };
    const planned = await executeTemplateOperation({ vault, source: "explicit" }, change, { dryRun: true });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") throw new Error("expected plan");
    const applied = await executeTemplateOperation({ vault, source: "explicit" }, change, { approvedDigest: planned.approvalDigest });
    expect(applied.status).toBe("applied");
    const policy = JSON.parse(await readFile(join(vault, ".oms/template-policy.json"), "utf8")) as {
      templates: { note: { approvedSourceSignature?: string } };
    };
    expect(policy.templates.note.approvedSourceSignature).toBe(sha(Buffer.from(sourceBytes).toString("utf8")));
  });

  it("rejects a between-read verify-existing source change without publishing controls", async () => {
    const vault = await fixture();
    const sourcePath = join(vault, "Templates/note.md");
    const stable = new Uint8Array(Buffer.from("---\ntitle: note\n---\nbody\n"));
    const transient = new Uint8Array(Buffer.from("---\ntitle: transient\n---\ntransient body\n"));
    const policyPath = join(vault, ".oms/template-policy.json");
    const projectionPath = join(vault, ".oms/types.json");
    const binding = parseTemplatePolicy(await readFile(policyPath, "utf8")).templates.note!;
    const change = {
      mode: "update" as const,
      templateId: binding.templateId,
      binding,
      source: { path: binding.sourcePath, bytes: stable, publication: "verify-existing" as const },
    };
    const before = await Promise.all([readFile(policyPath), readFile(projectionPath), readFile(sourcePath)]);
    sourceProofRead.target = sourcePath;
    sourceProofRead.stable = stable;
    sourceProofRead.transient = transient;

    await expect(executeTemplateOperation({ vault, source: "explicit" }, change, { dryRun: true }))
      .rejects.toThrow("TEMPLATE_TRANSACTION_MANIFEST_INVALID");

    expect(sourceProofRead.reads).toBe(1);
    expect(await Promise.all([readFile(policyPath), readFile(projectionPath), readFile(sourcePath)])).toEqual(before);

    sourceProofRead.target = "";
    sourceProofRead.stable = null;
    sourceProofRead.transient = null;
    const planned = await executeTemplateOperation({ vault, source: "explicit" }, change, { dryRun: true });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") throw new Error("expected plan");
    const applied = await executeTemplateOperation(
      { vault, source: "explicit" },
      change,
      { approvedDigest: planned.approvalDigest },
    );
    expect(applied.status).toBe("applied");
    const published = parseTemplatePolicy(await readFile(policyPath, "utf8")).templates.note!;
    expect(published.approvedSourceSignature).toBe(sha(Buffer.from(stable).toString("utf8")));
    expect(published.approvedBodySignature).toBe(sha("body\n"));
  });

  it("rejects a between-read already-moved verify-existing source change without publishing controls", async () => {
    const vault = await fixture();
    const oldPath = join(vault, "Templates/note.md");
    const newPath = join(vault, "Templates/moved.md");
    await rename(oldPath, newPath);
    const stable = new Uint8Array(await readFile(newPath));
    const transient = new Uint8Array(Buffer.from("---\ntitle: transient\n---\ntransient body\n"));
    const policyPath = join(vault, ".oms/template-policy.json");
    const projectionPath = join(vault, ".oms/types.json");
    const binding: TemplateBinding = {
      templateId: "note" as TemplateId,
      destinationClass: "registered-existing",
      renderer: "obsidian-core",
      sourceFolder: "Templates" as TemplateBinding["sourceFolder"],
      sourcePath: "Templates/moved.md" as TemplateSourcePath,
      contract: "note",
      naming: "{{slug}}.md",
    };
    const change = {
      mode: "update" as const,
      templateId: binding.templateId,
      binding,
      source: { path: binding.sourcePath, bytes: stable, publication: "verify-existing" as const },
      moveStrategy: "register-already-moved" as const,
    };
    const before = await Promise.all([readFile(policyPath), readFile(projectionPath), readFile(newPath)]);
    sourceProofRead.target = newPath;
    sourceProofRead.stable = stable;
    sourceProofRead.transient = transient;

    await expect(executeTemplateOperation({ vault, source: "explicit" }, change, { dryRun: true }))
      .rejects.toThrow("TEMPLATE_TRANSACTION_MANIFEST_INVALID");

    expect(sourceProofRead.reads).toBe(1);
    expect(await Promise.all([readFile(policyPath), readFile(projectionPath), readFile(newPath)])).toEqual(before);

    sourceProofRead.target = "";
    sourceProofRead.stable = null;
    sourceProofRead.transient = null;
    const planned = await executeTemplateOperation({ vault, source: "explicit" }, change, { dryRun: true });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") throw new Error("expected plan");
    expect((await executeTemplateOperation(
      { vault, source: "explicit" },
      change,
      { approvedDigest: planned.approvalDigest },
    )).status).toBe("applied");
    expect(await readFile(newPath)).toEqual(Buffer.from(stable));
  });

  it("normalizes Korean NFD update identities for guarded dry-run and apply", async () => {
    const unicode = await unicodeFixture();
    const sourceBytes = new Uint8Array(Buffer.from("---\ntitle: New\n---\nPublished body\n"));
    const current = parseTemplatePolicy(await readFile(join(unicode.vault, ".oms/template-policy.json"), "utf8"));
    const binding = current.templates[unicode.id]!;
    const change = {
      mode: "update" as const,
      templateId: unicode.nfdId,
      binding: { ...binding, templateId: unicode.nfdId },
      source: { path: unicode.sourcePath, bytes: sourceBytes, publication: "write" as const },
    };
    const taxonomyBefore = await readFile(join(unicode.vault, ".oms/taxonomy.json"));
    const planned = await executeTemplateOperation({ vault: unicode.vault, source: "explicit" }, change, { dryRun: true });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") throw new Error("expected plan");
    expect(planned.operations).toEqual([expect.objectContaining({ templateId: unicode.id })]);
    expect(planned.operations.some(operation => operation.templateId === unicode.nfdId)).toBe(false);
    const applied = await executeTemplateOperation({ vault: unicode.vault, source: "explicit" }, change, { approvedDigest: planned.approvalDigest });
    expect(applied.status).toBe("applied");
    expect(await readFile(join(unicode.vault, unicode.sourcePath))).toEqual(Buffer.from(sourceBytes));
    const afterPolicy = parseTemplatePolicy(await readFile(join(unicode.vault, ".oms/template-policy.json"), "utf8"));
    expect(afterPolicy.templates[unicode.id]?.approvedSourceSignature).toBe(sha(Buffer.from(sourceBytes).toString("utf8")));
    expect(afterPolicy.templates[unicode.id]?.approvedBodySignature).toBe(sha("Published body\n"));
    expect(await readFile(join(unicode.vault, ".oms/taxonomy.json"))).toEqual(taxonomyBefore);
    const resolved = await loadResolvedTemplates(unicode.vault);
    expect(resolved.templates[unicode.id]?.targetFolder).toBe("Preserved");
    expect(Object.keys(resolved.pending)).toEqual([]);
  });

  it("normalizes Korean NFD identities at direct composition entry", async () => {
    const unicode = await unicodeFixture();
    const sourceBytes = new Uint8Array(Buffer.from("---\ntitle: Direct\n---\nDirect body\n"));
    const current = parseTemplatePolicy(await readFile(join(unicode.vault, ".oms/template-policy.json"), "utf8"));
    const binding = current.templates[unicode.id]!;
    const change = {
      mode: "update" as const,
      templateId: unicode.nfdId,
      binding: { ...binding, templateId: unicode.nfdId },
      source: { path: unicode.sourcePath, bytes: sourceBytes, publication: "write" as const },
    };
    const manifest = await buildTemplateCompositionManifest(unicode.vault, change, unicode.options);
    expect(manifest.operations).toEqual([expect.objectContaining({ templateId: unicode.id })]);
    expect(manifest.operations.some(operation => operation.templateId === unicode.nfdId)).toBe(false);
    const applied = await executeTemplateTransaction(unicode.vault, manifest, { approvedDigest: manifest.approvalDigest });
    expect(applied.status).toBe("applied");
    expect(await readFile(join(unicode.vault, unicode.sourcePath))).toEqual(Buffer.from(sourceBytes));
    const afterPolicy = parseTemplatePolicy(await readFile(join(unicode.vault, ".oms/template-policy.json"), "utf8"));
    expect(afterPolicy.templates[unicode.id]?.approvedSourceSignature).toBe(sha(Buffer.from(sourceBytes).toString("utf8")));
    expect(afterPolicy.templates[unicode.id]?.approvedBodySignature).toBe(sha("Direct body\n"));
    expect(Object.keys((await loadResolvedTemplates(unicode.vault)).pending)).toEqual([]);
  });

  it("rejects verify-existing publication for create", async () => {
    const vault = await fixture();
    const change = {
      mode: "create" as const,
      binding: {
        templateId: "new" as TemplateId,
        destinationClass: "registered-existing" as const,
        renderer: "obsidian-core" as const,
        sourceFolder: "Templates" as TemplateBinding["sourceFolder"],
        sourcePath: "Templates/new.md" as TemplateSourcePath,
        contract: "note",
        naming: "{{slug}}.md",
      },
      source: {
        path: "Templates/new.md" as TemplateSourcePath,
        bytes: new Uint8Array(Buffer.from("---\ntitle: new\n---\nbody\n")),
        publication: "verify-existing" as const,
      },
    };
    await expect(executeTemplateOperation({ vault, source: "explicit" }, change, { dryRun: true }))
      .rejects.toThrow(/create source publication must be write/u);
  });

  it("registers an already-moved source while the old registered path is absent", async () => {
    const vault = await fixture();
    const oldPath = join(vault, "Templates/note.md");
    const newPath = join(vault, "Templates/moved.md");
    await rename(oldPath, newPath);
    const content = new Uint8Array(await readFile(newPath));
    const binding: TemplateBinding = {
      templateId: "note" as TemplateId,
      destinationClass: "registered-existing",
      renderer: "obsidian-core",
      sourceFolder: "Templates" as TemplateBinding["sourceFolder"],
      sourcePath: "Templates/moved.md" as TemplateSourcePath,
      contract: "note",
      naming: "{{slug}}.md",
    };
    const change = {
      mode: "update" as const,
      templateId: binding.templateId,
      binding,
      source: { path: binding.sourcePath, bytes: content, publication: "verify-existing" as const },
      moveStrategy: "register-already-moved" as const,
    };

    const planned = await executeTemplateOperation({ vault, source: "explicit" }, change, { dryRun: true });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") throw new Error("expected plan");
    const applied = await executeTemplateOperation({ vault, source: "explicit" }, change, { approvedDigest: planned.approvalDigest });
    expect(applied.status).toBe("applied");
    expect(await readFile(newPath)).toEqual(Buffer.from(content));
  });

  it("routes reconcile through the source-preserving transaction branch", async () => {
    const vault = await fixture();
    const completed = await completeInterview(vault);
    const before = await readFile(join(vault, "Templates/note.md"));
    const change = {
      mode: "reconcile" as const,
      census: completed.context.census,
      ledgerDigest: null,
      answers: completed.answers,
      proposedPolicy: completed.proposedPolicy,
      reviewedTemplateIds: completed.reviewedTemplateIds,
    };
    const planned = await executeTemplateOperation({ vault, source: "explicit" }, change, { dryRun: true });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") throw new Error("expected reconcile plan");
    expect(planned.mode).toBe("reconcile");
    const applied = await executeTemplateOperation({ vault, source: "explicit" }, change, { approvedDigest: planned.approvalDigest });
    expect(applied.status).toBe("applied");
    expect(await readFile(join(vault, "Templates/note.md"))).toEqual(before);
  });
});

describe("taxonomyRouting", () => {
  it("canonicalizes map and folder template references without changing precedence", () => {
    const id = "메모";
    const nfd = id.normalize("NFD");
    const routing = taxonomyRouting(
      ".oms/taxonomy.json",
      new TextEncoder().encode(JSON.stringify({
        templates: { [nfd]: { templateFolder: "Root" } },
        folders: {
          First: { template: nfd },
          Second: { templates: [nfd] },
        },
      })),
    );
    expect(routing.targetFolders.get(id)).toBe("Second");
  });

  it("rejects canonically equivalent taxonomy definition keys", () => {
    const id = "메모";
    const nfd = id.normalize("NFD");
    expect(() => taxonomyRouting(
      ".oms/taxonomy.json",
      new TextEncoder().encode(JSON.stringify({
        templates: {
          [nfd]: { templateFolder: "First" },
          [id]: { templateFolder: "Second" },
        },
      })),
    )).toThrow("TEMPLATE_ID_DUPLICATE");
  });
});
