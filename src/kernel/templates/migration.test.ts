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
  it("excludes only colliding files and keeps compatible siblings", async () => {
    const root = await fixture();
    await put(root, "Custom/agent/meeting.md", body);
    await put(root, "Custom/manual/meeting.md", body);
    const proposal = await planTemplateMigration(root, { templateFolders: folders });
    const duplicates = proposal.diagnostics.filter(item => item.code === "TEMPLATE_ID_DUPLICATE");
    expect(duplicates.map(item => item.path).sort()).toEqual(["Custom/agent/meeting.md", "Custom/manual/meeting.md"]);
    expect(duplicates.every(item => item.blocking === false && item.remediation?.includes("explicit"))).toBe(true);
    expect(proposal.bindings.map(item => item.templateId)).toEqual(["note"]);
    expect(proposal.unresolved).toEqual([]);
    expect(proposal.inputDigest).toBeDefined();
  });
  it("blocks when every file collides and nothing compatible remains", async () => {
    const root = await fresh();
    await put(root, "Custom/note.md", body);
    await put(root, "Other/note.md", body);
    const proposal = await planTemplateMigration(root, { templateFolders: [...folders, { path: "Other", mode: "auto" }] });
    expect(proposal.diagnostics.filter(item => item.code === "TEMPLATE_ID_DUPLICATE")).toHaveLength(2);
    expect(proposal.unresolved.map(item => item.code)).toEqual(["TEMPLATE_CANDIDATE_INCOMPATIBLE"]);
    expect(proposal.inputDigest).toBeUndefined();
  });
  it("strips .template/.eta suffixes into stable IDs", async () => {
    const root = await fixture();
    await put(root, "Custom/Daily Note.template.md", body);
    await put(root, "Custom/zt-cite.eta.md", body);
    const proposal = await planTemplateMigration(root, { templateFolders: folders });
    expect(proposal.candidates.map(item => item.templateId)).toEqual(["daily-note", "note", "zt-cite"]);
  });
  it("keeps mixed renderer candidates visible and selects only approvable conventions", async () => {
    const root = await fixture();
    await put(root, "Custom/templater.md", "---\ntitle: <% tp.file.title %>\n---\nbody\n");
    await put(root, "Custom/custom.md", "---\ntitle: {{unknown}}\n---\nbody\n");
    await put(root, "Custom/plain.md", "no frontmatter\n");
    await put(root, "Custom/formatted.md", "---\ntemplate: formatted\ncreated: \"{{date:YYYY-MM-DD}}\"\n---\nbody\n");
    const proposal = await planTemplateMigration(root, { templateFolders: folders });
    const byPath = new Map(proposal.diagnostics.map(item => [item.path, item]));
    expect(byPath.get("Custom/templater.md")).toMatchObject({ code: "FIELD_FILLED_BY_OBSIDIAN", field: "title", blocking: false });
    expect(byPath.get("Custom/custom.md")).toMatchObject({ code: "TEMPLATE_EXPRESSION_UNSUPPORTED", blocking: false });
    expect(byPath.get("Custom/plain.md")).toMatchObject({ code: "TEMPLATE_CONTRACT_UNOBSERVED", blocking: false });
    expect(proposal.diagnostics.every(item => item.remediation !== undefined)).toBe(true);
    expect(proposal.candidates.map(item => [item.templateId, item.renderer])).toEqual([
      ["custom", "obsidian-core"],
      ["formatted", "obsidian-core"],
      ["note", "obsidian-core"],
      ["plain", "none"],
      ["templater", "templater"],
    ]);
    expect(proposal.bindings.map(item => item.templateId)).toEqual(["formatted", "note", "templater"]);
    expect(proposal.unresolved).toEqual([]);
    expect(proposal.inputDigest).toBeDefined();
  });
  it("extracts Templater YAML fields without executing or copying expressions", async () => {
    const root = await fixture();
    await put(root, "Custom/mail.md", "---\ntemplate: mail\nsubject: <% tp.file.title %>\npriority: 1\n---\nbody\n");
    await put(root, ".oms/taxonomy.json", JSON.stringify({ folders: {}, templates: { note: { templateFolder: "Notes" }, mail: { templateFolder: "Mail" } } }));
    const proposal = await planTemplateMigration(root, { templateFolders: folders });
    const candidate = proposal.candidates.find(item => item.templateId === "mail");
    expect(candidate).toMatchObject({ renderer: "templater", filledBy: ["subject"], bodyExternal: false });
    expect(proposal.bindings.find(item => item.templateId === "mail")).toMatchObject({ renderer: "templater", contract: "mail" });
    const manifest = await buildMigrationManifest(root, proposal, { base: { fields: {} } });
    const policy = JSON.parse(new TextDecoder().decode(manifest.controls[0].proposed.bytes));
    const projection = JSON.parse(new TextDecoder().decode(manifest.controls[2].proposed.bytes));
    expect(policy.contracts.mail.fields.subject).toEqual({ filledBy: "obsidian" });
    expect(projection.managed.templates.mail).toMatchObject({ renderer: "templater", fields: { subject: { filledBy: "obsidian" } } });
    expect(new TextDecoder().decode(manifest.controls[2].proposed.bytes)).not.toContain("<%");
  });
  it("binds an observed script-first source to inferred fields and leaves an unobserved sibling unbound", async () => {
    const root = await fixture();
    await put(root, "Custom/script.md", "<%*\nconst secret = \"never execute\";\n%>\n");
    await put(root, "Custom/unseen.md", "<%* throw new Error(\"never execute\") %>\n");
    await put(root, "Notes/script-sample.md", "---\ntemplate: script\ntopic: observed\nrating: 3\n---\nprivate note body\n");
    await put(root, ".obsidian/types.json", JSON.stringify({ types: { template: "text", topic: "text", rating: "number" } }));
    await put(root, ".oms/taxonomy.json", JSON.stringify({ folders: {}, templates: { note: { templateFolder: "Notes" }, script: { templateFolder: "Notes" }, unseen: { templateFolder: "Unseen" } } }));
    const proposal = await planTemplateMigration(root, { templateFolders: folders });
    expect(proposal.candidates.find(item => item.templateId === "script")?.contractFromNotes).toMatchObject({
      status: "observed",
      samples: 1,
      coverage: { rating: 1, template: 1, topic: 1 },
    });
    expect(proposal.candidates.find(item => item.templateId === "unseen")?.contractFromNotes).toMatchObject({ status: "unobserved", samples: 0 });
    expect(proposal.bindings.map(item => item.templateId)).toContain("script");
    expect(proposal.bindings.map(item => item.templateId)).not.toContain("unseen");
    expect(proposal.input?.authority).toContainEqual(expect.objectContaining({ logicalId: "script#sample-1", vaultRelativePath: "Notes/script-sample.md", contentDigest: expect.stringMatching(/^sha256:/) }));
    const manifest = await buildMigrationManifest(root, proposal, { base: { fields: {} } });
    const projectionText = new TextDecoder().decode(manifest.controls[2].proposed.bytes);
    const projection = JSON.parse(projectionText);
    expect(projection.managed.templates.script).toMatchObject({ renderer: "none", keyOrder: [], fields: { topic: { type: "text", required: true }, rating: { type: "number", required: true } } });
    expect(projectionText).not.toContain("private note body");
    expect(projectionText).not.toContain("never execute");
  });
  it("rejects stale inferred samples both before composition and before apply", async () => {
    const root = await fixture();
    await put(root, "Custom/script.md", "<%* const value = 1 %>\n");
    await put(root, "Notes/script.md", "---\ntemplate: script\ntopic: first\n---\nbody\n");
    await put(root, ".obsidian/types.json", JSON.stringify({ types: { template: "text", topic: "text" } }));
    await put(root, ".oms/taxonomy.json", JSON.stringify({ folders: {}, templates: { note: { templateFolder: "Notes" }, script: { templateFolder: "Notes" } } }));
    const staleProposal = await planTemplateMigration(root, { templateFolders: folders });
    await put(root, "Notes/script.md", "---\ntemplate: script\ntopic: changed\n---\nbody\n");
    await expect(buildMigrationManifest(root, staleProposal, { base: { fields: {} } })).rejects.toThrow("observed samples changed");
    const currentProposal = await planTemplateMigration(root, { templateFolders: folders });
    const manifest = await buildMigrationManifest(root, currentProposal, { base: { fields: {} } });
    await put(root, "Notes/script.md", "---\ntemplate: script\ntopic: changed-again\n---\nbody\n");
    await expect(applyTemplateMigration(root, currentProposal, manifest, { approvedDigest: manifest.approvalDigest })).rejects.toThrow("observed samples changed");
  });
  it("does not truncate or bind an oversized source while compatible siblings still compose", async () => {
    const root = await fixture();
    const oversized = `<%* ${"x".repeat(262_144)} %>\n`;
    await put(root, "Custom/huge.md", oversized);
    const proposal = await planTemplateMigration(root, { templateFolders: folders });
    expect(proposal.candidates.find(item => item.templateId === "huge")?.bytes.byteLength).toBe(Buffer.byteLength(oversized));
    expect(proposal.bindings.map(item => item.templateId)).not.toContain("huge");
    expect(proposal.diagnostics).toContainEqual(expect.objectContaining({ code: "TEMPLATE_PROPOSAL_OVERSIZE", path: "Custom/huge.md", blocking: false }));
    await expect(buildMigrationManifest(root, proposal, { base: { fields: {} } })).resolves.toBeDefined();
  });
  it("proposes a starter template only for an empty default folder and writes it on approval", async () => {
    const root = await fresh();
    await put(root, ".obsidian/types.json", JSON.stringify({ types: { template: "text" } }));
    await put(root, ".oms/taxonomy.json", JSON.stringify({ folders: {}, templates: { note: { templateFolder: "Notes" } } }));
    await mkdir(path.join(root, "Custom"), { recursive: true });
    const proposal = await planTemplateMigration(root, { templateFolders: folders });
    expect(proposal.candidates).toMatchObject([{ templateId: "note", sourcePath: "Custom/note.md", publication: "write", destinationClass: "managed-default" }]);
    expect(proposal.unresolved).toEqual([]);
    const manifest = await buildMigrationManifest(root, proposal, { base: { fields: {} } });
    expect(manifest.sources[0]).toMatchObject({ path: "Custom/note.md", action: "write", expectedCurrent: { state: "absent" } });
    expect((await applyTemplateMigration(root, proposal, manifest, { dryRun: true })).status).toBe("planned");
    expect(existsSync(path.join(root, "Custom/note.md"))).toBe(false);
    expect((await applyTemplateMigration(root, proposal, manifest, { approvedDigest: manifest.approvalDigest })).status).toBe("applied");
    expect(await readFile(path.join(root, "Custom/note.md"), "utf8")).toBe("---\ntemplate: note\n---\n<!-- oms:content -->\n");
    expect((await loadResolvedTemplates(root)).templates.note?.targetFolder).toBe("Notes");
    const rescan = await planTemplateMigration(root);
    expect(rescan.candidates.map(item => item.publication)).toEqual(["verify-existing"]);
  });
  it("does not propose a starter publication for a non-default or non-empty folder", async () => {
    const root = await fixture();
    await put(root, "Custom/plain.md", "no frontmatter\n");
    await rm(path.join(root, "Custom/note.md"));
    const proposal = await planTemplateMigration(root, { templateFolders: folders });
    expect(proposal.candidates).toMatchObject([{ templateId: "plain", renderer: "none", contractFromNotes: { status: "unobserved", samples: 0 } }]);
    expect(proposal.candidates.some(item => item.publication === "write")).toBe(false);
    expect(proposal.bindings).toEqual([]);
    expect(proposal.unresolved.map(item => item.code)).toEqual(["TEMPLATE_CANDIDATE_INCOMPATIBLE"]);
    const noDefault = await planTemplateMigration(root, { templateFolders: [{ path: "Empty", mode: "auto" }] });
    expect(noDefault.candidates).toEqual([]);
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
    expect(proposal.diagnostics.filter(item => item.code === "MIGRATION_TEMPLATE_UNSAFE")).toHaveLength(2);
    expect(proposal.unresolved.map(item => item.path)).toEqual(["Linked"]);
    expect(proposal.bindings.map(item => item.sourcePath)).toEqual(["Custom/note.md"]);
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
