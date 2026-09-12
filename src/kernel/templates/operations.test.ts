import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadResolvedTemplates, proposeTaxonomyPlacement, sourceSignature, taxonomyRouting } from "./resolver.js";
import { writeResolvedTemplateNote } from "../capture/safe.js";
import { normalizeTemplateFolderPath, normalizeTemplateSourcePath, validateTemplateId } from "./paths.js";
import { registerExistingTemplate } from "./register.js";
import { executeTemplateOperation } from "./operations.js";
import type { Digest, GuardedTemplateRequest, TemplateBinding, TemplateId, TemplateSourcePath } from "./types.js";

const roots: string[] = [];
const sha = (value: string): Digest => `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;

async function fixture(): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), "oms-template-operation-"));
  roots.push(vault);
  await Promise.all([mkdir(join(vault, ".oms")), mkdir(join(vault, ".obsidian")), mkdir(join(vault, "Templates"))]);
  const policy = JSON.stringify({ version: 3, templateFolders: [{ path: "Templates", mode: "manual", default: true }], defaultTemplate: "note", base: { fields: {} }, contracts: { note: { intent: "note", fields: { title: { type: "text" } }, views: [] } }, templates: { note: { templateId: "note", destinationClass: "registered-existing", renderer: "obsidian-core", sourceFolder: "Templates", sourcePath: "Templates/note.md", contract: "note", naming: "{{slug}}.md" } } });
  const taxonomy = JSON.stringify({ templates: { note: { templateFolder: "notes" } } });
  const obsidian = JSON.stringify({ types: { title: "text" } });
  const template = "---\ntitle: note\n---\nbody\n";
  const sources = [{ logicalId: "template-policy", signature: sha(policy) }, { logicalId: "taxonomy", signature: sha(taxonomy) }, { logicalId: "obsidian-types", signature: sha(obsidian) }, { path: "Templates/note.md", signature: sha(template) }];
  const projection = JSON.stringify({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sources), sources }, managed: { base: { fields: {} }, globalAxes: {}, templates: { note: { templateId: "note", destinationClass: "registered-existing", renderer: "obsidian-core", sourcePath: "Templates/note.md", targetFolder: "notes", keyOrder: ["title"], fields: { title: { type: "text" } }, views: [], naming: "{{slug}}.md", bodySignature: sha("body\n") } } } });
  await Promise.all([
    writeFile(join(vault, ".oms/template-policy.json"), policy),
    writeFile(join(vault, ".oms/taxonomy.json"), taxonomy),
    writeFile(join(vault, ".oms/types.json"), projection),
    writeFile(join(vault, ".obsidian/types.json"), obsidian),
    writeFile(join(vault, "Templates/note.md"), template),
  ]);
  return vault;
}

afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("executeTemplateOperation", () => {
  it("preserves ontology and explicit routes while rejecting malformed placement", () => {
    const taxonomy = { extension: { keep: true }, folders: { Legacy: { intent: "Keep", template: "note" } }, templates: { book: { intent: "Books", extension: [1, 2] } }, globalAxes: {} };
    const bytes = new TextEncoder().encode(JSON.stringify(taxonomy));
    const proposed = proposeTaxonomyPlacement(bytes, "book", "80. References/01 Book");
    expect(JSON.parse(new TextDecoder().decode(proposed))).toEqual({ ...taxonomy, templates: { book: { ...taxonomy.templates.book, templateFolder: "80. References/01 Book" } } });
    expect(proposeTaxonomyPlacement(bytes, "note", "Legacy")).toBe(bytes);
    expect(() => proposeTaxonomyPlacement(bytes, "note", "Different")).toThrow("TEMPLATE_PLACEMENT_CONFLICT");
    for (const folder of ["../outside", "/absolute", ".oms", ""]) expect(() => proposeTaxonomyPlacement(bytes, "book", folder)).toThrow("TEMPLATE_SOURCE_UNSAFE");
    for (const invalid of [{ templates: [] }, { templates: { book: 2 } }, { templates: { book: { templateFolder: 2 } } }, { folders: { Books: { templateFolder: 2 } } }]) {
      expect(() => taxonomyRouting(".oms/taxonomy.json", new TextEncoder().encode(JSON.stringify(invalid)))).toThrow("TEMPLATE_SOURCE_INVALID");
    }
  });

  it.each([undefined, "80. References/01 Book"])("registers book with optional placement %s and resolves only the actual write destination", async targetFolder => {
    const vault = await fixture();
    const target = { vault, source: "explicit" as const };
    const binding = { templateId: validateTemplateId("book"), destinationClass: "managed-default" as const, renderer: "obsidian-core" as const, sourceFolder: normalizeTemplateFolderPath("Templates"), sourcePath: normalizeTemplateSourcePath("Templates/book.md"), contract: "note", naming: "{{title}}.md" };
    const content = "---\ntitle: '{{title}}'\n---\n## Thinking\n- \n";
    const change = { mode: "create" as const, binding, source: { path: binding.sourcePath, bytes: new TextEncoder().encode(content), publication: "write" as const }, targetFolder };
    const paths = [".oms/template-policy.json", ".oms/taxonomy.json", ".oms/types.json", ".obsidian/types.json", "Templates/note.md"];
    const before = await Promise.all(paths.map(p => readFile(join(vault, p))));
    const planned = await executeTemplateOperation(target, change, { dryRun: true });
    expect(planned.status).toBe("planned");
    expect(await Promise.all(paths.map(p => readFile(join(vault, p))))).toEqual(before);
    await expect(readFile(join(vault, binding.sourcePath))).rejects.toMatchObject({ code: "ENOENT" });
    if (planned.status !== "planned") throw new Error("expected plan");
    const rejected = await executeTemplateOperation(target, change, { approvedDigest: sha("wrong approval") });
    expect(rejected.status).toBe("rejected");
    expect((await executeTemplateOperation(target, { ...change, targetFolder: "Different" }, { approvedDigest: planned.approvalDigest })).status).toBe("rejected");
    expect(await Promise.all(paths.map(p => readFile(join(vault, p))))).toEqual(before);
    expect((await executeTemplateOperation(target, change, { approvedDigest: planned.approvalDigest })).status).toBe("applied");
    const convention = await loadResolvedTemplates(vault);
    expect(convention.templates.book?.targetFolder).toBe(targetFolder);
    expect(convention.templates.note?.targetFolder).toBe("notes");
    expect(await readFile(join(vault, "Templates/book.md"), "utf8")).toBe(content);
    expect(await readFile(join(vault, ".obsidian/types.json"))).toEqual(before[3]);
    expect(await readFile(join(vault, "Templates/note.md"))).toEqual(before[4]);
    const request = { target, convention, templateId: "book", mode: "create" as const, frontmatter: { title: "The Attention Economy" }, body: "", dryRun: true };
    const note = await writeResolvedTemplateNote(request);
    if (targetFolder === undefined) {
      expect(note.status).toBe("ask");
      expect(note.reason).toContain("TEMPLATE_PLACEMENT_UNDECLARED");
      expect((await writeResolvedTemplateNote({ ...request, targetFolder: "Chosen" })).notePath).toBe("Chosen/The Attention Economy.md");
      expect(await readFile(join(vault, ".oms/taxonomy.json"))).toEqual(before[1]);
    } else {
      expect(note.status).toBe("written");
      expect(note.notePath).toBe("80. References/01 Book/The Attention Economy.md");
      expect(note.body).toBe("## Thinking\n- \n");
    }
    expect((await writeResolvedTemplateNote({ ...request, targetFolder: "../escape" })).status).toBe("rejected");
  });

  it("registers existing source with explicit placement without changing the source", async () => {
    const vault = await fixture();
    const content = "---\ntitle: book\n---\n## Thinking\n";
    await writeFile(join(vault, "Templates/book.md"), content);
    const request = { templateId: "book", sourceFolder: "Templates", sourcePath: "Templates/book.md", renderer: "obsidian-core" as const, filledBy: [], contract: "note", naming: "{{title}}.md", targetFolder: "Books" };
    const planned = await registerExistingTemplate(vault, request, { dryRun: true });
    if (planned.status !== "planned") throw new Error("expected plan");
    expect((await registerExistingTemplate(vault, request, { approvedDigest: planned.approvalDigest })).status).toBe("applied");
    expect((await loadResolvedTemplates(vault)).templates.book?.targetFolder).toBe("Books");
    expect(await readFile(join(vault, "Templates/book.md"), "utf8")).toBe(content);
    await expect(registerExistingTemplate(vault, { ...request, targetFolder: "Other" }, { approvedDigest: planned.approvalDigest })).rejects.toThrow("TEMPLATE_PLACEMENT_CONFLICT");
  });

  it("derives CAS server-side and rejects an approval after authority drift", async () => {
    const vault = await fixture();
    const change = { mode: "register-folder" as const, folder: { path: "More" as never, mode: "manual" as const } };
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
});
