import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backfillDefaults, diagnoseTemplates, regenerateTypes } from "./doctor.js";
import { summarizeRuntimeHistory } from "../runtime/event-summary.js";
import { loadResolvedTemplates, sourceSignature } from "./resolver.js";
import type { Digest } from "./types.js";

const roots: string[] = [];
const sha = (value: string): Digest => `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;
async function vault(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "oms-template-doctor-"));
  roots.push(root);
  await Promise.all([".oms", ".obsidian", "Templates", "notes"].map(dir => mkdir(path.join(root, dir), { recursive: true })));
  const policy = `${JSON.stringify({ version: 3, templateFolders: [{ path: "Templates", mode: "manual", default: true }], base: { fields: {} }, contracts: { note: { intent: "note", fields: {}, views: [] } }, templates: { note: { templateId: "note", destinationClass: "registered-existing", renderer: "obsidian-core", sourceFolder: "Templates", sourcePath: "Templates/note.md", contract: "note", naming: "{{slug}}.md" } } })}\n`;
  const taxonomy = JSON.stringify({ folders: { notes: { concept: "note", template: "note" } } });
  const obsidian = "{\"title\":\"text\"}\n";
  const template = "---\ntitle: template\n---\nbody\n";
  const descriptors = [{ logicalId: "template-policy", signature: sha(policy) }, { logicalId: "taxonomy", signature: sha(taxonomy) }, { logicalId: "obsidian-types", signature: sha(obsidian) }, { path: "Templates/note.md", signature: sha(template) }];
  const projection = `${JSON.stringify({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(descriptors), sources: descriptors }, managed: { base: { fields: {} }, globalAxes: {}, templates: { note: { templateId: "note", destinationClass: "registered-existing", renderer: "obsidian-core", sourcePath: "Templates/note.md", targetFolder: "notes", keyOrder: ["title"], fields: { title: { type: "text" } }, views: [], naming: "{{slug}}.md", bodySignature: sha("body\n") } } } }, null, 2)}\n`;
  await Promise.all([
    writeFile(path.join(root, ".oms", "template-policy.json"), policy, "utf8"),
    writeFile(path.join(root, ".oms", "taxonomy.json"), taxonomy, "utf8"),
    writeFile(path.join(root, ".oms", "types.json"), projection, "utf8"),

    writeFile(path.join(root, ".obsidian", "types.json"), obsidian, "utf8"),
    writeFile(path.join(root, "Templates", "note.md"), template, "utf8"),
  ]);
  return root;
}
async function note(root: string, content = "---\nconcept: note\ncustom: keep\n---\nbody\r\n"): Promise<void> { await writeFile(path.join(root, "notes", "one.md"), content, "utf8"); }
async function addSecondTemplate(root: string): Promise<void> {
  const policyPath = path.join(root, ".oms", "template-policy.json");
  const taxonomyPath = path.join(root, ".oms", "taxonomy.json");
  const projectionPath = path.join(root, ".oms", "types.json");
  const reference = "---\ntitle: reference\n---\nreference body\n";
  await writeFile(path.join(root, "Templates", "reference.md"), reference);
  const policy = JSON.parse(await readFile(policyPath, "utf8")) as {
    templates: Record<string, unknown>;
    contracts: Record<string, unknown>;
  };
  policy.contracts.reference = { intent: "reference", fields: {}, views: [] };
  policy.templates.reference = {
    templateId: "reference",
    destinationClass: "managed-default",
    renderer: "obsidian-core",
    sourceFolder: "Templates",
    sourcePath: "Templates/reference.md",
    contract: "reference",
    naming: "{{slug}}.md",
  };
  const policyText = `${JSON.stringify(policy)}\n`;
  await writeFile(policyPath, policyText);
  const taxonomy = JSON.parse(await readFile(taxonomyPath, "utf8")) as { templates?: Record<string, unknown> };
  taxonomy.templates = { ...(taxonomy.templates ?? {}), reference: { templateFolder: "references" } };
  const taxonomyText = JSON.stringify(taxonomy);
  await writeFile(taxonomyPath, taxonomyText);
  const obsidian = await readFile(path.join(root, ".obsidian", "types.json"), "utf8");
  const noteSource = await readFile(path.join(root, "Templates", "note.md"), "utf8");
  const descriptors = [
    { logicalId: "template-policy", signature: sha(policyText) },
    { logicalId: "taxonomy", signature: sha(taxonomyText) },
    { logicalId: "obsidian-types", signature: sha(obsidian) },
    { path: "Templates/note.md", signature: sha(noteSource) },
    { path: "Templates/reference.md", signature: sha(reference) },
  ];
  const projection = {
    version: "oms.types.v1",
    generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(descriptors), sources: descriptors },
    managed: {
      base: { fields: {} },
      globalAxes: {},
      templates: {
        note: { templateId: "note", destinationClass: "registered-existing", renderer: "obsidian-core", sourcePath: "Templates/note.md", targetFolder: "notes", keyOrder: ["title"], fields: { title: { type: "text" } }, views: [], naming: "{{slug}}.md", bodySignature: sha("body\n") },
        reference: { templateId: "reference", destinationClass: "managed-default", renderer: "obsidian-core", sourcePath: "Templates/reference.md", targetFolder: "references", keyOrder: ["title"], fields: { title: { type: "text" } }, views: [], naming: "{{slug}}.md", bodySignature: sha("reference body\n") },
      },
    },
  };
  await writeFile(projectionPath, `${JSON.stringify(projection, null, 2)}\n`);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("template doctor", () => {
  it("diagnoses a healthy vault without writing", async () => {
    const root = await vault();
    const before = await readFile(path.join(root, ".oms", "types.json"), "utf8");
    expect((await diagnoseTemplates({ vault: root, source: "cwd" })).status).toBe("healthy");
    expect((await diagnoseTemplates({ vault: root, source: "cwd" })).diagnostics.filter(item => item.code === "TEMPLATE_SOURCE_DRIFT")).toEqual([]);
    expect(await readFile(path.join(root, ".oms", "types.json"), "utf8")).toBe(before);
  });

  it("records verification history and bounds external drift between observations", async () => {
    const root = await vault();
    const first = await diagnoseTemplates({ vault: root, source: "explicit" });
    expect(first.history?.templates.note).toMatchObject({
      status: "observed",
      uses: 0,
      previousSignature: null,
      changedBetween: null,
    });

    await writeFile(path.join(root, "Templates", "note.md"), "---\ntitle: changed\n---\nbody\n");
    const second = await diagnoseTemplates({ vault: root, source: "explicit" });
    const noteHistory = second.history?.templates.note;
    expect(noteHistory?.previousSignature).toBe(sha("---\ntitle: template\n---\nbody\n"));
    expect(noteHistory?.changedBetween?.[0]).toBe(first.history?.templates.note.lastVerifiedAt);
    expect(noteHistory?.changedBetween?.[1]).toBe(noteHistory?.lastVerifiedAt);
    expect(noteHistory?.lastUsedAt).toBeNull();

    await regenerateTypes({ target: { vault: root, source: "explicit" }, request: { dryRun: true } });
    const repeated = await diagnoseTemplates({ vault: root, source: "explicit" });
    expect(repeated.history?.templates.note).toMatchObject({
      currentSignature: noteHistory?.currentSignature,
      previousSignature: sha("---\ntitle: template\n---\nbody\n"),
      changedBetween: noteHistory?.changedBetween,
    });
  });

  it("summarizes an absent journal without creating runtime state", async () => {
    const root = await vault();
    const runtimeRoot = path.join(root, "..", `oms-runtime-absent-${path.basename(root)}`);
    expect(existsSync(runtimeRoot)).toBe(false);
    expect(summarizeRuntimeHistory({ vaultPath: root, runtimeRoot })).toEqual({
      events: 0,
      uses: 0,
      verifications: 0,
      gaps: 0,
      templates: {},
    });
    expect(existsSync(runtimeRoot)).toBe(false);
  });

  it("caps vault-level findings with maxPerTemplate", async () => {
    const root = await vault();
    await writeFile(path.join(root, ".oms", "template-policy.json"), "{}\n");
    await writeFile(path.join(root, ".oms", "types.json"), "{}\n");
    const diagnosis = await diagnoseTemplates({
      vault: root,
      source: "explicit",
      maxPerTemplate: 1,
    });
    expect(diagnosis.status).toBe("needs-repair");
    expect(diagnosis.diagnostics).toHaveLength(1);
  });
  it("fails closed on an existing unsupported policy for diagnosis and repair", async () => {
    const root = await vault();
    const legacy = `${JSON.stringify({ version: 2, templateFolder: "Templates", base: { fields: {} }, contracts: {}, templates: {} })}\n`;
    await writeFile(path.join(root, ".oms", "template-policy.json"), legacy);
    const before = await readFile(path.join(root, ".oms", "types.json"));
    const diagnosis = await diagnoseTemplates({ vault: root, source: "explicit" });
    expect(diagnosis.diagnostics.some(item => item.code === "TEMPLATE_POLICY_VERSION_UNSUPPORTED")).toBe(true);
    expect(await regenerateTypes({ target: { vault: root, source: "explicit" }, request: { dryRun: true } }))
      .toMatchObject({ status: "rejected", code: "TEMPLATE_POLICY_VERSION_UNSUPPORTED" });
    expect(await readFile(path.join(root, ".oms", "types.json"))).toEqual(before);
  });
  it("requires JSON taxonomy and never converts a legacy YAML file", async () => {
    const root = await vault();
    await rm(path.join(root, ".oms", "taxonomy.json"));
    await writeFile(path.join(root, ".oms", "taxonomy.yaml"), "folders: {}\n");
    const diagnosis = await diagnoseTemplates({ vault: root, source: "explicit" });
    expect(diagnosis.diagnostics).toContainEqual(expect.objectContaining({ code: "TEMPLATE_CONTROL_MISSING", path: ".oms/taxonomy.json" }));
    expect(await readFile(path.join(root, ".oms", "taxonomy.yaml"), "utf8")).toBe("folders: {}\n");
  });
  it("reports projection drift", async () => {
    const root = await vault();
    await writeFile(path.join(root, "Templates", "note.md"), "---\ntitle: changed\n---\nbody\n", "utf8");
    expect((await diagnoseTemplates({ vault: root, source: "explicit" })).diagnostics).toContainEqual({
      code: "TEMPLATE_SOURCE_DRIFT",
      templateId: "note",
      path: "Templates/note.md",
      expected: sha("---\ntitle: template\n---\nbody\n"),
      actual: sha("---\ntitle: changed\n---\nbody\n"),
      remediation: "run regenerate-types with the returned approval digest",
    });
  });
  it("reports each changed registered source with its projection and actual signatures", async () => {
    const root = await vault();
    await addSecondTemplate(root);
    const changedNote = "---\ntitle: changed note\n---\nbody\n";
    const changedReference = "---\ntitle: changed reference\n---\nreference body\n";
    await Promise.all([
      writeFile(path.join(root, "Templates", "note.md"), changedNote),
      writeFile(path.join(root, "Templates", "reference.md"), changedReference),
    ]);

    const drift = (await diagnoseTemplates({ vault: root, source: "explicit" })).diagnostics
      .filter(item => item.code === "TEMPLATE_SOURCE_DRIFT");
    expect(drift).toEqual([
      {
        code: "TEMPLATE_SOURCE_DRIFT",
        templateId: "note",
        path: "Templates/note.md",
        expected: sha("---\ntitle: template\n---\nbody\n"),
        actual: sha(changedNote),
        remediation: "run regenerate-types with the returned approval digest",
      },
      {
        code: "TEMPLATE_SOURCE_DRIFT",
        templateId: "reference",
        path: "Templates/reference.md",
        expected: sha("---\ntitle: reference\n---\nreference body\n"),
        actual: sha(changedReference),
        remediation: "run regenerate-types with the returned approval digest",
      },
    ]);
  });
  it("reports changed policy authority at its vault-relative control path", async () => {
    const root = await vault();
    const policyPath = path.join(root, ".oms", "template-policy.json");
    const original = await readFile(policyPath, "utf8");
    const policy = JSON.parse(original) as Record<string, unknown>;
    policy.extensions = { retained: true };
    const changed = `${JSON.stringify(policy)}\n`;
    await writeFile(policyPath, changed);

    const drift = (await diagnoseTemplates({ vault: root, source: "explicit" })).diagnostics
      .filter(item => item.code === "TEMPLATE_SOURCE_DRIFT");
    expect(drift).toEqual([{
      code: "TEMPLATE_SOURCE_DRIFT",
      path: ".oms/template-policy.json",
      expected: sha(original),
      actual: sha(changed),
      remediation: "run regenerate-types with the returned approval digest",
    }]);
  });
  it("regenerates a drifted projection from dry-run to approved apply", async () => {
    const root = await vault();
    await writeFile(path.join(root, "Templates", "note.md"), "---\ntitle: changed\n---\nbody\n", "utf8");
    const dry = await regenerateTypes({ target: { vault: root, source: "explicit" }, request: { dryRun: true } });
    expect(dry.status).toBe("planned");
    if (dry.status !== "planned") return;
    const applied = await regenerateTypes({ target: { vault: root, source: "explicit" }, request: { approvedDigest: dry.approvalDigest } });
    expect(applied.status).toBe("applied");
    expect((await diagnoseTemplates({ vault: root, source: "explicit" })).status).toBe("healthy");
  });
  it("repairs projection drift without relocating sources across default-less registered folders", async () => {
    const root = await vault();
    await mkdir(path.join(root, "Imported"), { recursive: true });
    const policy = `${JSON.stringify({
      version: 3,
      templateFolders: [
        { path: "Templates", mode: "manual" },
        { path: "Imported", mode: "manual" },
      ],
      base: { fields: {} },
      contracts: {
        note: { intent: "note", fields: {}, views: [] },
        reference: { intent: "reference", fields: {}, views: [] },
      },
      templates: {
        note: {
          templateId: "note",
          destinationClass: "managed-default",
          renderer: "obsidian-core",
          sourceFolder: "Templates",
          sourcePath: "Templates/note.md",
          contract: "note",
          naming: "{{slug}}.md",
        },
        reference: {
          templateId: "reference",
          destinationClass: "registered-existing",
          renderer: "obsidian-core",
          sourceFolder: "Imported",
          sourcePath: "Imported/reference.md",
          contract: "reference",
          naming: "{{slug}}.md",
        },
      },
    })}\n`;
    const taxonomy = JSON.stringify({
      templates: {
        note: { templateFolder: "notes" },
        reference: { templateFolder: "references" },
      },
    });
    const noteSource = "---\ntitle: template\n---\nbody\n";
    const referenceSource = "---\ntitle: reference\n---\nreference body\n";
    await Promise.all([
      writeFile(path.join(root, ".oms", "template-policy.json"), policy),
      writeFile(path.join(root, ".oms", "taxonomy.json"), taxonomy),
      writeFile(path.join(root, "Templates", "note.md"), noteSource),
      writeFile(path.join(root, "Imported", "reference.md"), referenceSource),
      writeFile(path.join(root, ".oms", "types.json"), "{}\n"),
    ]);
    const beforePolicy = await readFile(path.join(root, ".oms", "template-policy.json"));
    const beforeNote = await readFile(path.join(root, "Templates", "note.md"));
    const beforeReference = await readFile(path.join(root, "Imported", "reference.md"));

    const dry = await regenerateTypes({
      target: { vault: root, source: "explicit" },
      request: { dryRun: true },
    });
    expect(dry.status).toBe("planned");
    expect(await readFile(path.join(root, ".oms", "types.json"), "utf8")).toBe("{}\n");
    expect(await readFile(path.join(root, ".oms", "template-policy.json"))).toEqual(beforePolicy);
    expect(await readFile(path.join(root, "Templates", "note.md"))).toEqual(beforeNote);
    expect(await readFile(path.join(root, "Imported", "reference.md"))).toEqual(beforeReference);
    if (dry.status !== "planned") return;

    const applied = await regenerateTypes({
      target: { vault: root, source: "explicit" },
      request: { approvedDigest: dry.approvalDigest },
    });
    expect(applied.status).toBe("applied");
    expect(await readFile(path.join(root, ".oms", "template-policy.json"))).toEqual(beforePolicy);
    expect(await readFile(path.join(root, "Templates", "note.md"))).toEqual(beforeNote);
    expect(await readFile(path.join(root, "Imported", "reference.md"))).toEqual(beforeReference);
    const savedPolicy = JSON.parse(await readFile(path.join(root, ".oms", "template-policy.json"), "utf8")) as {
      templates: Record<string, { sourceFolder: string; sourcePath: string }>;
    };
    expect(savedPolicy.templates).toMatchObject({
      note: { sourceFolder: "Templates", sourcePath: "Templates/note.md" },
      reference: { sourceFolder: "Imported", sourcePath: "Imported/reference.md" },
    });
    await expect(loadResolvedTemplates(root)).resolves.toMatchObject({
      templates: {
        note: { sourcePath: "Templates/note.md", targetFolder: "notes" },
        reference: { sourcePath: "Imported/reference.md", targetFolder: "references" },
      },
      managedSourcePaths: ["Imported/reference.md", "Templates/note.md"],
    });
  });
  it.each(["missing", "malformed"] as const)("regenerates a %s projection from authority", async state => {
    const root = await vault();
    const projectionPath = path.join(root, ".oms", "types.json");
    if (state === "missing") await rm(projectionPath);
    else await writeFile(projectionPath, "{}\n");
    const dry = await regenerateTypes({ target: { vault: root, source: "explicit" }, request: { dryRun: true } });
    expect(dry.status).toBe("planned");
    if (dry.status !== "planned") return;
    const applied = await regenerateTypes({
      target: { vault: root, source: "explicit" },
      request: { approvedDigest: dry.approvalDigest },
    });
    expect(applied.status).toBe("applied");
    expect((await diagnoseTemplates({ vault: root, source: "explicit" })).status).toBe("healthy");
  });
  it("rejects stale regeneration approval without changing the vault", async () => {
    const root = await vault();
    await writeFile(path.join(root, "Templates", "note.md"), "---\ntitle: changed\n---\nbody\n", "utf8");
    const dry = await regenerateTypes({ target: { vault: root, source: "explicit" }, request: { dryRun: true } });
    if (dry.status !== "planned") return;
    await writeFile(path.join(root, "Templates", "note.md"), "---\ntitle: newer\n---\nbody\n", "utf8");
    const before = await readFile(path.join(root, ".oms", "types.json"), "utf8");
    expect((await regenerateTypes({ target: { vault: root, source: "explicit" }, request: { approvedDigest: dry.approvalDigest } })).status).toBe("rejected");
    expect(await readFile(path.join(root, ".oms", "types.json"), "utf8")).toBe(before);
  });
  it("backfills exactly one note with a server-verifiable receipt", async () => {
    const root = await vault(); await note(root);
    const dry = await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/one.md", request: { dryRun: true } });
    expect(dry.status).toBe("planned");
    if (dry.status !== "planned") return;
    const applied = await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/one.md", request: { approvedDigest: dry.approvalDigest } });
    expect(applied).toMatchObject({ status: "applied", markerState: "complete" });
    expect(applied.status === "applied" && applied.verified.some(item => item.path === "notes/one.md" && item.state === "present")).toBe(true);
  });
  it("preserves unknown frontmatter and body bytes", async () => {
    const root = await vault(); await note(root);
    const dry = await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/one.md", request: { dryRun: true } });
    if (dry.status !== "planned") return;
    await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/one.md", request: { approvedDigest: dry.approvalDigest } });
    expect(await readFile(path.join(root, "notes", "one.md"), "utf8")).toBe("---\ntemplate: note\ncustom: keep\n---\nbody\r\n");
  });
  it("backfills BOM and CRLF notes without changing body bytes", async () => {
    const root = await vault();
    const original = "\ufeff---\r\nconcept: note\r\ncustom: keep\r\n---\r\nbody\r\n\r\n";
    await note(root, original);
    const dry = await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/one.md", request: { dryRun: true } });
    if (dry.status !== "planned") throw new Error("expected planned backfill");
    expect((await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/one.md", request: { approvedDigest: dry.approvalDigest } })).status).toBe("applied");
    expect(await readFile(path.join(root, "notes", "one.md"), "utf8")).toBe("\ufeff---\r\ntemplate: note\r\ncustom: keep\r\n---\r\nbody\r\n\r\n");
  });
  it("refuses unresolved legacy identity", async () => {
    const root = await vault(); await note(root, "---\nconcept: missing\n---\nbody\n");
    expect((await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/one.md", request: { dryRun: true } })).status).toBe("rejected");
  });
  it("refuses an ambiguous folder binding", async () => {
    const root = await vault();
    await mkdir(path.join(root, "notes", "one"), { recursive: true });
    await writeFile(path.join(root, "notes", "one", "child.md"), "---\nconcept: note\n---\nbody\n", "utf8");
    await writeFile(path.join(root, ".oms", "taxonomy.json"), JSON.stringify({ folders: { notes: { concept: "note" }, "notes/one": { concept: "note" } } }), "utf8");
    expect((await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/one/child.md", request: { dryRun: true } })).status).toBe("rejected");
  });
  it("rejects symlink and escaping note paths", async () => {
    const root = await vault(); await note(root); await symlink(path.join(root, "notes", "one.md"), path.join(root, "notes", "link.md"));
    expect((await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/link.md", request: { dryRun: true } })).status).toBe("rejected");
    expect((await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "../escape.md", request: { dryRun: true } })).status).toBe("rejected");
  });
  it("rejects cwd-inferred repair before filesystem mutation", async () => {
    const root = await vault(); await note(root); const before = await readFile(path.join(root, "notes", "one.md"), "utf8");
    expect((await backfillDefaults({ target: { vault: root, source: "cwd" }, notePath: "notes/one.md", request: { dryRun: true } })).status).toBe("rejected");
    expect(await readFile(path.join(root, "notes", "one.md"), "utf8")).toBe(before);
  });
  it("fails closed for malformed migration evidence before convention repair", async () => {
    const root = await vault(); await note(root);
    await writeFile(path.join(root, ".oms", "template-migration.json"), "{\"status\":\"in-progress\"}\n", "utf8");
    const diagnosis = await diagnoseTemplates({ vault: root, source: "explicit" });
    expect(diagnosis.migrationMarker).toBe("invalid");
    expect(diagnosis.diagnostics.some(item => item.code === "migration-incomplete")).toBe(true);
    const repaired = await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/one.md", request: { dryRun: true } });
    expect(repaired).toMatchObject({ status: "rejected", code: "migration-incomplete" });
  });
});
