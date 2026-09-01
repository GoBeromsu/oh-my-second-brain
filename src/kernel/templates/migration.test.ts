import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyTemplateMigration, buildMigrationManifest, planTemplateMigration } from "./migration.js";
import { diagnoseTemplates } from "./doctor.js";
import { loadResolvedTemplates } from "./resolver.js";
import type { Digest, TemplateCompositionManifest } from "./types.js";

let vault: string | undefined;
afterEach(async () => { if (vault !== undefined) await rm(vault, { recursive: true, force: true }); vault = undefined; });
async function fresh(): Promise<string> { vault = await mkdtemp(path.join(tmpdir(), "oms-template-migration-")); return vault; }
async function template(root: string, source: string, body = "---\ntemplate: note\n---\nbody\n"): Promise<void> { await mkdir(path.dirname(path.join(root, source)), { recursive: true }); await writeFile(path.join(root, source), body, "utf8"); }

const approval = "sha256:0000000000000000000000000000000000000000000000000000000000000000" as Digest;
const noManifest = {} as unknown as TemplateCompositionManifest;

describe("template migration planner", () => {
  it("plans an empty vault with no mutation", async () => {
    const root = await fresh();
    const proposal = await planTemplateMigration(root);
    expect(proposal.candidates).toEqual([]);
    expect(proposal.unresolved).toEqual([]);
    expect(existsSync(path.join(root, ".oms"))).toBe(false);
  });

  it("recursively discovers a configured custom template folder", async () => {
    const root = await fresh();
    await template(root, "My Templates/nested/reading.md");
    const proposal = await planTemplateMigration(root, { templateFolder: "My Templates" });
    expect(proposal.managedSourcePaths).toEqual(["My Templates/nested/reading.md"]);
    expect(proposal.candidates[0]?.templateId).toBe("reading");
  });

  it("excludes Obsidian and Templater sources from notes without adopting them as candidates", async () => {
    const root = await fresh();
    await template(root, "Templates/note.md");
    await template(root, "External/Obsidian/template.md", "{{ unsupported }}\n");
    await template(root, "External/Templater/mail-thread.template.md", "{{ unsupported }}\n");
    await mkdir(path.join(root, ".obsidian", "plugins", "templater-obsidian"), { recursive: true });
    await writeFile(path.join(root, ".obsidian", "templates.json"), JSON.stringify({ folder: "External/Obsidian" }));
    await writeFile(path.join(root, ".obsidian", "plugins", "templater-obsidian", "data.json"), JSON.stringify({
      templates_folder: "External/Templater",
      folder_templates: [{ folder: "mail", template: "External/Templater/mail-thread.template.md" }],
    }));
    await writeFile(path.join(root, ".obsidian", "types.json"), JSON.stringify({ types: { template: "string" } }));

    const proposal = await planTemplateMigration(root);
    expect(proposal.candidates.map(candidate => candidate.sourcePath)).toEqual(["Templates/note.md"]);
    expect(proposal.existingNotes.map(note => note.path)).not.toContain("External/Obsidian/template.md");
    expect(proposal.existingNotes.map(note => note.path)).not.toContain("External/Templater/mail-thread.template.md");
    expect(proposal.diagnostics.map(diagnostic => diagnostic.path)).not.toContain("External/Obsidian/template.md");
    expect(proposal.diagnostics.map(diagnostic => diagnostic.path)).not.toContain("External/Templater/mail-thread.template.md");
    expect(proposal.unresolved).toEqual([]);

    const defaultManifest = await buildMigrationManifest(root, proposal, { base: { fields: {} } });
    const explicitProposal = await planTemplateMigration(root, { templateFolder: "Templates" });
    const explicitManifest = await buildMigrationManifest(root, explicitProposal, { base: { fields: {} } });
    expect(defaultManifest.approvalDigest).toBe(explicitManifest.approvalDigest);
  });

  it("isolates external Templater sources while reporting a malformed ordinary note through doctor", async () => {
    const root = await fresh();
    await template(root, "External/Templater/source.template.md", "{{ unsupported }}\n");
    await mkdir(path.join(root, ".obsidian", "plugins", "templater-obsidian"), { recursive: true });
    await writeFile(path.join(root, ".obsidian", "plugins", "templater-obsidian", "data.json"), JSON.stringify({
      templates_folder: "External/Templater",
    }));
    await template(root, "Notes/broken.md", "---\ntitle: [unterminated\n---\n");
    const proposal = await planTemplateMigration(root);
    expect(proposal.unresolved).toContainEqual(expect.objectContaining({
      code: "MIGRATION_NOTE_INVALID",
      path: "Notes/broken.md",
    }));
    for (const paths of [
      proposal.candidates.map(candidate => candidate.sourcePath),
      proposal.diagnostics.map(diagnostic => diagnostic.path),
      proposal.unresolved.map(unresolved => unresolved.path),
    ]) expect(paths).not.toContain("External/Templater/source.template.md");
    const diagnosis = await diagnoseTemplates({ vault: root });
    expect(diagnosis.diagnostics).toContainEqual(expect.objectContaining({
      code: "MIGRATION_NOTE_INVALID",
      path: "Notes/broken.md",
    }));
    expect(diagnosis.diagnostics.map(diagnostic => diagnostic.path)).not.toContain("External/Templater/source.template.md");
    await expect(applyTemplateMigration(root, proposal, noManifest, { approvedDigest: approval })).rejects.toThrow("MIGRATION_UNRESOLVED_MAPPING");
  });

  it("imports an explicitly registered external source without rewriting bytes", async () => {
    const root = await fresh();
    const bytes = "---\ntemplate: imported\n---\ncustom body\n";
    await template(root, "External/capture.md", bytes);
    const proposal = await planTemplateMigration(root, { registeredTemplates: [{ templateId: "inbox-capture", sourcePath: "External/capture.md" }] });
    expect(proposal.candidates).toMatchObject([{ templateId: "inbox-capture", sourcePath: "External/capture.md", destinationClass: "registered-existing" }]);
    expect(await readFile(path.join(root, "External/capture.md"), "utf8")).toBe(bytes);
  });

  it("reports duplicate stable IDs and source paths before activation", async () => {
    const root = await fresh();
    await template(root, "Templates/reading.md");
    const proposal = await planTemplateMigration(root, { registeredTemplates: [{ templateId: "reading", sourcePath: "Templates/reading.md" }] });
    expect(proposal.unresolved.map(item => item.code)).toContain("TEMPLATE_ID_DUPLICATE");
    expect(proposal.unresolved.map(item => item.code)).toContain("TEMPLATE_SOURCE_DUPLICATE");
    expect(proposal.inputDigest).toBeUndefined();
  });

  it("rejects hidden and symlink candidates", async () => {
    const root = await fresh();
    await template(root, "Templates/.hidden.md");
    await template(root, "outside.md");
    await mkdir(path.join(root, "Templates"), { recursive: true });
    await symlink(path.join(root, "outside.md"), path.join(root, "Templates", "linked.md"));
    const proposal = await planTemplateMigration(root);
    expect(proposal.unresolved.filter(item => item.code === "MIGRATION_TEMPLATE_UNSAFE")).toHaveLength(2);
  });

  it("rejects registered templates beneath a symlink ancestor", async () => {
    const root = await fresh();
    await template(root, "Real/note.md");
    await symlink(path.join(root, "Real"), path.join(root, "Linked"));
    const proposal = await planTemplateMigration(root, {
      registeredTemplates: [{ templateId: "note", sourcePath: "Linked/note.md" }],
    });
    expect(proposal.unresolved.map(item => item.code)).toContain("MIGRATION_TEMPLATE_UNSAFE");
  });

  it("keeps legacy and unknown user extension bytes in its ledger", async () => {
    const root = await fresh();
    await mkdir(path.join(root, ".oms", "concepts"), { recursive: true });
    await writeFile(path.join(root, ".oms", "taxonomy.yaml"), "folders: {}\nuser-extension: keep-me\n");
    await writeFile(path.join(root, ".oms", "types.json"), '{"user-extension":{"keep":true}}\n');
    await writeFile(path.join(root, ".oms", "concepts", "literature.yaml"), "concept: literature\ncustom: preserve\n");
    const proposal = await planTemplateMigration(root);
    expect(new TextDecoder().decode(proposal.legacyLedger.find(entry => entry.path === ".oms/concepts/literature.yaml")?.bytes)).toContain("custom: preserve");
    expect(new TextDecoder().decode(proposal.legacyLedger.find(entry => entry.path === ".oms/types.json")?.bytes)).toContain("user-extension");
  });

  it("translates legacy taxonomy while retaining projection and taxonomy extensions", async () => {
    const root = await fresh();
    await template(root, "Templates/literature.md");
    await mkdir(path.join(root, ".oms", "concepts"), { recursive: true });
    await mkdir(path.join(root, ".obsidian"), { recursive: true });
    await writeFile(path.join(root, ".oms", "taxonomy.yaml"), "folders:\n  references:\n    concept: literature\n    routingLawStrict: true\nuser-extension:\n  preserved: yes\n");
    await writeFile(path.join(root, ".oms", "types.json"), '{"projection-extension":{"preserved":true}}\n');
    await writeFile(path.join(root, ".oms", "concepts", "literature.yaml"), "concept: literature\nintent: Processed source.\nfields: []\ncustom: preserve\n");
    await writeFile(path.join(root, ".obsidian", "types.json"), JSON.stringify({ types: { template: "string" } }));
    const manifest = await buildMigrationManifest(root, await planTemplateMigration(root), { base: { fields: {} } });
    expect(manifest.current.input.authority).toContainEqual(expect.objectContaining({
      kind: "legacy-contract",
      vaultRelativePath: ".oms/types.json",
    }));
    expect(manifest.proposed.input.authority).toContainEqual(expect.objectContaining({
      kind: "legacy-contract",
      vaultRelativePath: ".oms/types.json",
    }));
    const taxonomyControl = manifest.controls.find(control => control.kind === "taxonomy");
    const projectionControl = manifest.controls.find(control => control.kind === "projection");
    if (taxonomyControl?.proposed.state !== "present" || projectionControl?.proposed.state !== "present") throw new Error("expected migration controls");
    const taxonomy = new TextDecoder().decode(taxonomyControl.proposed.bytes);
    const projection = new TextDecoder().decode(projectionControl.proposed.bytes);
    expect(taxonomy).toContain("user-extension:");
    expect(taxonomy).toContain("template: literature");
    expect(projection).toContain("projection-extension");
  });

  it("translates legacy field semantics, axes, and list/null taxonomy cardinality", async () => {
    const root = await fresh();
    await template(root, "Templates/literature.md", "---\ntemplate: literature\nstatus: open\n---\n");
    await template(root, "Templates/term.md", "---\ntemplate: term\nstatus: open\n---\n");
    await mkdir(path.join(root, ".oms", "concepts"), { recursive: true });
    await mkdir(path.join(root, ".obsidian"), { recursive: true });
    await writeFile(path.join(root, ".oms", "concepts", "literature.yaml"), "concept: literature\nintent: Source\nfields:\n  - name: status\n    type: select\n    enum: [open, closed]\n    immutable: true\nviews:\n  - name: by-status\n    fields: [status]\n");
    await writeFile(path.join(root, ".oms", "concepts", "term.yaml"), "concept: term\nintent: Term\nfields: []\n");
    await writeFile(path.join(root, ".oms", "taxonomy.yaml"), "folders:\n  references:\n    intent: Processed external sources.\n    concept: [literature, term]\n  inbox:\n    intent: Unprocessed captures.\n    concept: null\n");
    await writeFile(path.join(root, ".oms", "types.json"), JSON.stringify({
      types: { status: "select" },
      allowedValues: { status: [{ value: "open", color: "green" }, "closed"] },
      axes: [
        { kind: "field", key: "status", type: "select", required: true, normalize: "lower", allowedValues: [{ value: "open", color: "green" }, "closed"] },
        { kind: "link", key: "related", type: "select", allowedValues: [{ value: "supports", intent: "positive", color: "green" }] },
      ],
    }));
    await writeFile(path.join(root, ".obsidian", "types.json"), JSON.stringify({ types: { template: "string", status: "select" } }));
    const proposal = await planTemplateMigration(root);
    const manifest = await buildMigrationManifest(root, proposal, { base: { fields: {} } });
    const policy = manifest.controls.find(control => control.kind === "policy")!;
    const projection = manifest.controls.find(control => control.kind === "projection")!;
    if (policy.proposed.state !== "present" || projection.proposed.state !== "present") throw new Error("expected proposed controls");
    const policyJson = JSON.parse(new TextDecoder().decode(policy.proposed.bytes));
    const projectionJson = JSON.parse(new TextDecoder().decode(projection.proposed.bytes));
    expect(policyJson.contracts.literature.fields.status).toMatchObject({ allowedValues: ["open", "closed"], immutable: true });
    expect(policyJson.contracts.literature.views).toEqual([{ name: "by-status", keys: ["status"] }]);
    expect(projectionJson.managed.globalAxes.related).toMatchObject({ kind: "link", key: "related" });
    expect(projectionJson.managed.globalAxes.related.members).toEqual([{ value: "supports", intent: "positive", color: "green" }]);
    expect(projectionJson.managed.globalAxes["folder-ontology"]).toEqual({
      kind: "folder",
      key: "folder",
      type: "text",
      intent: "Semantic meanings of vault folders.",
      members: ["inbox", "references"],
      extensions: { intents: { inbox: "Unprocessed captures.", references: "Processed external sources." } },
    });
    expect(new TextDecoder().decode(manifest.controls.find(control => control.kind === "taxonomy")!.proposed.bytes)).toContain("templates:");
    expect((await applyTemplateMigration(root, proposal, manifest, { approvedDigest: manifest.approvalDigest })).status).toBe("applied");
    const resolved = await loadResolvedTemplates(root);
    expect(resolved.templates.literature?.targetFolder).toBe("references");
    expect(resolved.templates.term?.targetFolder).toBe("references");
    expect(resolved.globalAxes["folder-ontology"]).toEqual(projectionJson.managed.globalAxes["folder-ontology"]);
  });

  it("blocks an unmarked note in a taxonomy-managed folder", async () => {
    const root = await fresh();
    await template(root, "Templates/note.md");
    await template(root, "notes/unmarked.md", "plain body\n");
    await mkdir(path.join(root, ".oms"), { recursive: true });
    await writeFile(path.join(root, ".oms", "taxonomy.yaml"), "folders:\n  notes:\n    concept: note\n");
    expect((await planTemplateMigration(root)).unresolved).toContainEqual(expect.objectContaining({
      code: "MIGRATION_NOTE_IDENTITY_UNRESOLVED",
      path: "notes/unmarked.md",
    }));
  });

  it("creates deterministic stable clones when one legacy concept is used by multiple folders", async () => {
    const root = await fresh();
    await template(root, "Templates/literature.md", "---\ntitle: Literature\n---\nbody\n");
    await mkdir(path.join(root, ".oms", "concepts"), { recursive: true });
    await mkdir(path.join(root, ".obsidian"), { recursive: true });
    await writeFile(path.join(root, ".oms", "taxonomy.yaml"), "folders:\n  books:\n    concept: literature\n  papers:\n    concept: literature\n");
    await writeFile(path.join(root, ".oms", "concepts", "literature.yaml"), "concept: literature\nintent: Source note.\nfields:\n  - name: title\n    type: text\n    required: true\n    normalize: trim\ncustom: preserve\n");
    await writeFile(path.join(root, ".obsidian", "types.json"), JSON.stringify({ types: { title: "text" } }));
    const proposal = await planTemplateMigration(root);
    expect(proposal.bindingClones.map(clone => clone.templateId)).toEqual(["literature--books", "literature--papers"]);
    expect(proposal.bindingClones.map(clone => clone.sourcePath)).toEqual([
      "Templates/literature--books.md",
      "Templates/literature--papers.md",
    ]);
    const manifest = await buildMigrationManifest(root, proposal, { base: { fields: {} } });
    expect(manifest.sources.map(source => [source.path, source.action])).toEqual([
      ["Templates/literature--books.md", "write"],
      ["Templates/literature--papers.md", "write"],
    ]);
    const policy = manifest.controls.find(control => control.kind === "policy");
    const taxonomy = manifest.controls.find(control => control.kind === "taxonomy");
    const projection = manifest.controls.find(control => control.kind === "projection");
    if (policy?.proposed.state !== "present" || taxonomy?.proposed.state !== "present" || projection?.proposed.state !== "present") throw new Error("expected proposed controls");
    const policyText = new TextDecoder().decode(policy.proposed.bytes);
    expect(policyText).toContain('"contract": "literature"');
    expect(policyText).toContain('"migrationProvenance"');
    expect(new TextDecoder().decode(taxonomy.proposed.bytes)).toContain("template: literature--books");
    const projectionJson = JSON.parse(new TextDecoder().decode(projection.proposed.bytes)) as {
      managed: { templates: Record<string, { fields: Record<string, unknown> }> };
    };
    expect(projectionJson.managed.templates["literature--books"]?.fields.title).toMatchObject({
      type: "text",
      required: true,
      normalize: "trim",
    });
  });

  it("fails preflight when folder names collapse to the same clone ID", async () => {
    const root = await fresh();
    await template(root, "Templates/literature.md");
    await mkdir(path.join(root, ".oms"), { recursive: true });
    await writeFile(path.join(root, ".oms", "taxonomy.yaml"), "folders:\n  Books:\n    concept: literature\n  books:\n    concept: literature\n");
    const proposal = await planTemplateMigration(root);
    expect(proposal.unresolved.map(item => item.code)).toContain("TEMPLATE_ID_DUPLICATE");
    expect(proposal.inputDigest).toBeUndefined();
  });

  it("inventories unresolved existing note identities and blocks activation before publisher use", async () => {
    const root = await fresh();
    await template(root, "Notes/note.md", "---\ntemplate: missing\n---\n");
    const proposal = await planTemplateMigration(root);
    expect(proposal.unresolved.map(item => item.code)).toContain("MIGRATION_NOTE_IDENTITY_UNRESOLVED");
    await expect(applyTemplateMigration(root, proposal, noManifest, { approvedDigest: approval })).rejects.toThrow("MIGRATION_UNRESOLVED_MAPPING");
    expect(existsSync(path.join(root, ".oms", "template-migration.json"))).toBe(false);
  });

  it("blocks activation for a mapped concept-only note until identity is persisted", async () => {
    const root = await fresh();
    await template(root, "Templates/note.md");
    await template(root, "Notes/legacy.md", "\ufeff---\r\nconcept: note\r\n---\r\n");
    const proposal = await planTemplateMigration(root);
    expect(proposal.unresolved.map(item => item.code)).toContain("MIGRATION_NOTE_IDENTITY_UNRESOLVED");
    expect(proposal.inputDigest).toBeUndefined();
  });

  it("rejects malformed manifests before any publisher marker mutation", async () => {
    const root = await fresh();
    const proposal = await planTemplateMigration(root);
    await expect(applyTemplateMigration(root, proposal, noManifest, { dryRun: true })).rejects.toThrow("MIGRATION_APPROVAL_MISMATCH");
    expect(existsSync(path.join(root, ".oms", "template-migration.json"))).toBe(false);
  });

  it("rejects missing approval and stale proposal input before publication", async () => {
    const root = await fresh();
    const proposal = await planTemplateMigration(root);
    const currentInputDigest = proposal.inputDigest;
    expect(currentInputDigest).toBeDefined();
    const sameInputManifest = { proposed: { inputDigest: currentInputDigest } } as unknown as TemplateCompositionManifest;
    const staleManifest = { proposed: { inputDigest: approval } } as unknown as TemplateCompositionManifest;
    await expect(applyTemplateMigration(root, proposal, sameInputManifest, {} as unknown as { readonly approvedDigest: Digest })).rejects.toThrow("MIGRATION_APPROVAL_MISMATCH");
    await expect(applyTemplateMigration(root, proposal, staleManifest, { approvedDigest: approval })).rejects.toThrow("MIGRATION_APPROVAL_MISMATCH");
    expect(existsSync(path.join(root, ".oms", "template-migration.json"))).toBe(false);
  });

  it("delegates approved apply, crash resume, and already-complete behavior only to transaction", async () => {
    const root = await fresh();
    const proposal = await planTemplateMigration(root);
    await expect(applyTemplateMigration(root, proposal, noManifest, { approvedDigest: approval })).rejects.toThrow("MIGRATION_APPROVAL_MISMATCH");
    expect(existsSync(path.join(root, ".oms", "template-migration.json"))).toBe(false);
  });

  it("composes bootstrap controls from authority without writing", async () => {
    const root = await fresh();
    await template(root, "Templates/note.md");
    await mkdir(path.join(root, ".obsidian"), { recursive: true });
    await writeFile(path.join(root, ".obsidian", "types.json"), JSON.stringify({ types: { template: "string" } }));
    const proposal = await planTemplateMigration(root);
    const manifest = await buildMigrationManifest(root, proposal, { base: { fields: {} } });
    expect(manifest.controls.map(control => control.expectedCurrent.state)).toEqual(["absent", "absent", "absent"]);
    expect(manifest.sources[0]?.action).toBe("verify-only");
    expect(existsSync(path.join(root, ".oms"))).toBe(false);
  });

  it("uses present control bytes as migration CAS states", async () => {
    const root = await fresh();
    await template(root, "Templates/note.md");
    await mkdir(path.join(root, ".obsidian"), { recursive: true });
    await writeFile(path.join(root, ".obsidian", "types.json"), JSON.stringify({ types: { template: "string" } }));
    const proposal = await planTemplateMigration(root);
    const bootstrap = await buildMigrationManifest(root, proposal, { base: { fields: {} } });
    await applyTemplateMigration(root, proposal, bootstrap, { approvedDigest: bootstrap.approvalDigest });
    const migration = await buildMigrationManifest(root, await planTemplateMigration(root), { base: { fields: {} } });
    expect(migration.controls.map(control => control.expectedCurrent.state)).toEqual(["present", "present", "present"]);
  });
});
