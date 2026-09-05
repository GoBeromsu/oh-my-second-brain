import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyTemplateMigration, buildMigrationManifest, planTemplateMigration } from "./migration.js";
import { loadResolvedTemplates } from "./resolver.js";
import type { Digest, TemplateCompositionManifest } from "./types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fresh(): Promise<string> { const root = await mkdtemp(path.join(tmpdir(), "oms-folder-setup-")); roots.push(root); return root; }
async function put(root: string, pathname: string, content: string): Promise<void> { await mkdir(path.dirname(path.join(root, pathname)), { recursive: true }); await writeFile(path.join(root, pathname), content); }
const folders = [{ path: "Custom", mode: "auto" as const, default: true as const }];
const body = "---\ntemplate: note\n---\nbody\n";
async function fixture(): Promise<string> {
  const root = await fresh();
  await put(root, "Custom/note.md", body);
  await put(root, ".obsidian/types.json", JSON.stringify({ types: { template: "text" } }));
  await put(root, ".oms/taxonomy.json", JSON.stringify({ folders: {}, templates: { note: { templateFolder: "Notes" } }, personal: { preserved: true } }));
  return root;
}
async function compose(root: string) {
  const proposal = await planTemplateMigration(root, { templateFolders: folders });
  const manifest = await buildMigrationManifest(root, proposal, { base: { fields: {} } });
  return { proposal, manifest };
}
const incorrect = `sha256:${"0".repeat(64)}` as Digest;

describe("explicit multi-folder setup", () => {
  it("blocks a missing selection without inventing folders or writing controls", async () => {
    const root = await fresh();
    const proposal = await planTemplateMigration(root);
    expect(proposal.templateFolders).toEqual([]);
    expect(proposal.unresolved).toContainEqual(expect.objectContaining({ code: "TEMPLATE_FOLDER_SELECTION_REQUIRED" }));
    expect(proposal.inputDigest).toBeUndefined();
    expect(existsSync(path.join(root, ".oms"))).toBe(false);
  });
  it("never selects an Obsidian hint automatically", async () => {
    const root = await fresh();
    await put(root, ".obsidian/templates.json", JSON.stringify({ folder: "Custom" }));
    await put(root, "Custom/note.md", body);
    const proposal = await planTemplateMigration(root);
    expect(proposal.bindings).toEqual([]);
    expect(proposal.existingNotes).toEqual([]);
    expect(proposal.inputDigest).toBeUndefined();
  });
  it("scans selected folders recursively and records each source folder", async () => {
    const root = await fresh();
    await put(root, "Custom/nested/reading.md", body);
    await put(root, "Other/daily.md", body);
    const proposal = await planTemplateMigration(root, { templateFolders: [...folders, { path: "Other", mode: "auto" }] });
    expect(proposal.bindings.map(item => [item.templateId, item.sourceFolder])).toEqual([["daily", "Other"], ["reading", "Custom"]]);
    expect(proposal.input?.templateFolders).toHaveLength(2);
  });
  it("manual folders do not automatically propose bindings", async () => {
    const root = await fixture();
    const proposal = await planTemplateMigration(root, { templateFolders: [{ path: "Custom", mode: "manual" }] });
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.bindings).toEqual([]);
    await expect(buildMigrationManifest(root, proposal, { base: { fields: {} } })).rejects.toThrow("select templates");
  });
  it("allows an explicit stable identity in a manual registered folder", async () => {
    const root = await fresh();
    await put(root, "Custom/Unusual Name.md", body);
    const proposal = await planTemplateMigration(root, { templateFolders: [{ path: "Custom", mode: "manual" }], registeredTemplates: [{ templateId: "chosen-id", sourcePath: "Custom/Unusual Name.md" }] });
    expect(proposal.unresolved).toEqual([]);
    expect(proposal.bindings[0]).toMatchObject({ templateId: "chosen-id", sourceFolder: "Custom", destinationClass: "registered-existing" });
    expect(await readFile(path.join(root, "Custom/Unusual Name.md"), "utf8")).toBe(body);
  });
  it("rejects duplicate IDs across different folders", async () => {
    const root = await fresh();
    await put(root, "Custom/note.md", body);
    await put(root, "Other/note.md", body);
    const proposal = await planTemplateMigration(root, { templateFolders: [...folders, { path: "Other", mode: "auto" }] });
    expect(proposal.unresolved.map(item => item.code)).toContain("TEMPLATE_ID_DUPLICATE");
    expect(proposal.inputDigest).toBeUndefined();
  });
  it("rejects repeated explicit source registration", async () => {
    const root = await fixture();
    const registration = { templateId: "note", sourcePath: "Custom/note.md" };
    const proposal = await planTemplateMigration(root, { templateFolders: folders, registeredTemplates: [registration, registration] });
    expect(proposal.unresolved.map(item => item.code)).toContain("TEMPLATE_SOURCE_DUPLICATE");
  });
  it("rejects source paths outside registered folders", async () => {
    const root = await fresh();
    await put(root, "Other/note.md", body);
    const proposal = await planTemplateMigration(root, { templateFolders: folders, registeredTemplates: [{ templateId: "note", sourcePath: "Other/note.md" }] });
    expect(proposal.unresolved).toContainEqual(expect.objectContaining({ code: "MIGRATION_TEMPLATE_INVALID", path: "Other/note.md" }));
  });
  it("rejects symlink folders and sources without following them", async () => {
    const root = await fixture();
    await symlink(path.join(root, "Custom"), path.join(root, "Linked"));
    await symlink(path.join(root, "Custom/note.md"), path.join(root, "Custom/link.md"));
    const proposal = await planTemplateMigration(root, { templateFolders: [...folders, { path: "Linked", mode: "auto" }] });
    expect(proposal.unresolved.filter(item => item.code === "MIGRATION_TEMPLATE_UNSAFE")).toHaveLength(2);
  });
  it("reports malformed ordinary notes per file", async () => {
    const root = await fixture();
    await put(root, "Notes/broken.md", "---\ntitle: [unterminated\n---\n");
    const proposal = await planTemplateMigration(root, { templateFolders: folders });
    expect(proposal.unresolved).toContainEqual(expect.objectContaining({ code: "MIGRATION_NOTE_INVALID", path: "Notes/broken.md" }));
    expect(proposal.inputDigest).toBeUndefined();
  });
  it("requires an explicit taxonomy note destination", async () => {
    const root = await fixture();
    await put(root, ".oms/taxonomy.json", '{"folders":{}}');
    await expect(compose(root)).rejects.toThrow("TEMPLATE_PLACEMENT_UNDECLARED: note");
  });
  it("retains JSON taxonomy bytes and ignores legacy YAML and concepts", async () => {
    const root = await fixture();
    const yaml = "malformed: [untouched\n";
    await put(root, ".oms/taxonomy.yaml", yaml);
    await put(root, ".oms/concepts/note.yaml", yaml);
    const before = await readFile(path.join(root, ".oms/taxonomy.json"), "utf8");
    const { proposal, manifest } = await compose(root);
    expect(Object.hasOwn(manifest, "legacyCleanup")).toBe(false);
    expect(manifest.outputs.map(item => item.finalVaultRelativePath)).not.toContain(".oms/taxonomy.yaml");
    expect(manifest.controls[1].action).toBe("verify-only");
    expect((await applyTemplateMigration(root, proposal, manifest, { approvedDigest: manifest.approvalDigest })).status).toBe("applied");
    expect(await readFile(path.join(root, ".oms/taxonomy.json"), "utf8")).toBe(before);
    expect(await readFile(path.join(root, ".oms/taxonomy.yaml"), "utf8")).toBe(yaml);
    expect(await readFile(path.join(root, ".oms/concepts/note.yaml"), "utf8")).toBe(yaml);
    expect((await loadResolvedTemplates(root)).templates.note?.targetFolder).toBe("Notes");
  });
  it("dry-runs without publishing policy or projection and applies only its approved digest", async () => {
    const root = await fixture();
    const { proposal, manifest } = await compose(root);
    expect((await applyTemplateMigration(root, proposal, manifest, { dryRun: true })).status).toBe("planned");
    expect(existsSync(path.join(root, ".oms/template-policy.json"))).toBe(false);
    expect(existsSync(path.join(root, ".oms/types.json"))).toBe(false);
    expect((await applyTemplateMigration(root, proposal, manifest, { approvedDigest: incorrect })).status).toBe("rejected");
    expect((await applyTemplateMigration(root, proposal, manifest, { approvedDigest: manifest.approvalDigest })).status).toBe("applied");
    expect(await readFile(path.join(root, "Custom/note.md"), "utf8")).toBe(body);
  });
  it("preserves opaque projection extensions without importing legacy field semantics", async () => {
    const root = await fixture();
    await put(root, ".oms/types.json", JSON.stringify({ types: { template: "number" }, personal: { retained: true }, extensions: { declared: ["kept"] } }));
    const { manifest } = await compose(root);
    const projection = JSON.parse(new TextDecoder().decode(manifest.controls[2].proposed.bytes));
    expect(projection.extensions).toEqual({ types: { template: "number" }, personal: { retained: true }, declared: ["kept"] });
    expect(projection.managed.templates.note.fields.template.type).toBe("text");
  });
  it.each(["{broken", '{"extensions":false}', '{"personal":1,"extensions":{"personal":2}}'])("rejects unsafe projection metadata without overwriting %s", async original => {
    const root = await fixture();
    await put(root, ".oms/types.json", original);
    await expect(compose(root)).rejects.toThrow("PROJECTION_INVALID");
    expect(await readFile(path.join(root, ".oms/types.json"), "utf8")).toBe(original);
  });
  it("reuses saved v3 folder selection and retains existing bindings on rescan", async () => {
    const root = await fixture();
    const { proposal, manifest } = await compose(root);
    await applyTemplateMigration(root, proposal, manifest, { approvedDigest: manifest.approvalDigest });
    const saved = await planTemplateMigration(root);
    expect(saved.templateFolders).toEqual(folders);
    expect(saved.bindings).toEqual(proposal.bindings);
    const rerun = await buildMigrationManifest(root, saved, { base: { fields: {} } });
    expect(rerun.controls.map(item => item.action)).toEqual(["verify-only", "verify-only", "verify-only"]);
  });
  it("does not derive a folder from unsupported policy and exposes replaced keys", async () => {
    const root = await fixture();
    await put(root, ".oms/template-policy.json", JSON.stringify({ version: 1, templateFolder: "NeverAdopt", writers: { field: "author", identifiers: ["human"] }, custom: { preserve: true } }));
    const unselected = await planTemplateMigration(root);
    expect(unselected.templateFolders).toEqual([]);
    expect(unselected.inputDigest).toBeUndefined();
    const { proposal, manifest } = await compose(root);
    expect(proposal.droppedKeys).toEqual(["templateFolder", "version"]);
    expect(manifest.controls[0].expectedCurrent.state).toBe("present");
    const proposed = JSON.parse(new TextDecoder().decode(manifest.controls[0].proposed.bytes));
    expect(proposed).toMatchObject({ version: 3, writers: { field: "author", identifiers: ["human"] }, extensions: { custom: { preserve: true } } });
    expect((await applyTemplateMigration(root, proposal, manifest, { approvedDigest: manifest.approvalDigest })).status).toBe("applied");
  });
  it("rejects a policy changed after scan, and one changed after dry-run", async () => {
    const root = await fixture();
    const original = '{"version":1,"templateFolder":"Old"}';
    await put(root, ".oms/template-policy.json", original);
    const { proposal, manifest } = await compose(root);
    await put(root, ".oms/template-policy.json", '{"version":2,"templateFolder":"Changed"}');
    await expect(buildMigrationManifest(root, proposal, { base: { fields: {} } })).rejects.toThrow("MIGRATION_APPROVAL_MISMATCH");
    expect((await applyTemplateMigration(root, proposal, manifest, { approvedDigest: manifest.approvalDigest })).status).toBe("rejected");
  });
  it("rejects source changes between scan and composition", async () => {
    const root = await fixture();
    const proposal = await planTemplateMigration(root, { templateFolders: folders });
    await put(root, "Custom/note.md", `${body}changed\n`);
    await expect(buildMigrationManifest(root, proposal, { base: { fields: {} } })).rejects.toThrow("MIGRATION_APPROVAL_MISMATCH");
  });
  it("invalidates approval when recomposition observes a different discarded policy", async () => {
    const root = await fixture();
    await put(root, ".oms/template-policy.json", '{"version":1,"templateFolder":"Old"}');
    const first = await compose(root);
    const changed = '{"version":2,"templateFolder":"Changed"}';
    await put(root, ".oms/template-policy.json", changed);
    const second = await compose(root);
    expect(second.manifest.proposed.inputDigest).toBe(first.manifest.proposed.inputDigest);
    expect(second.manifest.approvalDigest).not.toBe(first.manifest.approvalDigest);
    expect((await applyTemplateMigration(root, second.proposal, second.manifest, { approvedDigest: first.manifest.approvalDigest })).status).toBe("rejected");
    expect(await readFile(path.join(root, ".oms/template-policy.json"), "utf8")).toBe(changed);
  });
  it("rejects malformed manifests and missing approvals before publication", async () => {
    const root = await fixture();
    const { proposal, manifest } = await compose(root);
    await expect(applyTemplateMigration(root, proposal, {} as TemplateCompositionManifest, { dryRun: true })).rejects.toThrow("MIGRATION_APPROVAL_MISMATCH");
    await expect(applyTemplateMigration(root, proposal, manifest, {} as { approvedDigest: Digest })).rejects.toThrow("MIGRATION_APPROVAL_MISMATCH");
    expect(existsSync(path.join(root, ".oms/template-migration.json"))).toBe(false);
  });
});
