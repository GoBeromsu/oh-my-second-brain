import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ModelsConfigV1 } from "../engine/embed/config.js";
import { applySetup, composeSetup, decideNonInteractiveSetup, decideSetup, inspectSetup, publishSetupModels } from "./service.js";

let vault: string | undefined;
afterEach(async () => {
  if (vault !== undefined) await rm(vault, { recursive: true, force: true });
  vault = undefined;
});

const modelsConfig: ModelsConfigV1 = {
  schemaVersion: 1,
  embed: { provider: "gguf", model: "embeddinggemma-300m", revision: "v1.0.0", sha256: "a".repeat(64), promptScheme: "embeddinggemma-v1" },
  rerank: { provider: "gguf", model: "reranker", revision: "v1.0.0", sha256: "b".repeat(64) },
  generate: { provider: "gguf", model: "generator", revision: "v1.0.0", sha256: "c".repeat(64), promptScheme: "qmd-query-expansion-v2.8.3" },
};

async function fresh(files: Record<string, string> = {}): Promise<string> {
  vault = await mkdtemp(path.join(tmpdir(), "oms-template-setup-"));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(vault, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  return vault;
}

const template = "---\ntemplate: note\n---\nbody\n";
const taxonomy = `${JSON.stringify({ folders: { Notes: { template: "note" } } })}\n`;
const obsidianTypes = JSON.stringify({ types: { template: "string" } });

function savedPolicy(folder = "Saved Templates"): string {
  return `${JSON.stringify({
    version: 3,
    templateFolders: [{ path: folder, mode: "auto", default: true }],
    defaultTemplate: "note",
    base: { fields: {} },
    contracts: { base: { intent: "Base note", fields: {}, views: [] } },
    templates: {
      note: {
        templateId: "note",
        destinationClass: "registered-existing",
        sourceFolder: folder,
        sourcePath: `${folder}/note.md`,
        contract: "base",
        naming: "{{date}}-{{slug}}.md",
      },
    },
  })}\n`;
}

describe("template-first setup service", () => {
  it("uses an explicit folder selection and exposes its provenance without writing", async () => {
    const root = await fresh({ "My Templates/nested/reading.md": template });
    const before = await readdir(root);

    const state = await inspectSetup({
      vault: root,
      templateFolders: [{ path: "My Templates", mode: "auto", default: true }],
    });

    expect(state.selectedTemplateFolders).toEqual([{ path: "My Templates", mode: "auto", default: true }]);
    expect(state.templateFolderSource).toBe("explicit");
    expect(state.templateFolderCandidates).toContainEqual({
      path: "My Templates",
      provenance: ["explicit", "vault-walk"],
    });
    expect(state.proposal.managedSourcePaths).toEqual(["My Templates/nested/reading.md"]);
    expect(await readdir(root)).toEqual(before);
    expect(existsSync(path.join(root, ".oms"))).toBe(false);
  });

  it("reuses saved valid-v3 folders as the only implicit selection", async () => {
    const root = await fresh({
      ".oms/template-policy.json": savedPolicy(),
      "Saved Templates/note.md": template,
    });

    const state = await inspectSetup({ vault: root });

    expect(state.templateFolderSource).toBe("stored-v3");
    expect(state.selectedTemplateFolders.map(folder => folder.path)).toEqual(["Saved Templates"]);
    expect(state.templateFolderCandidates).toContainEqual({
      path: "Saved Templates",
      provenance: ["stored-v3", "vault-walk"],
    });
  });

  it("shows configuration and vault-walk hints without automatically selecting them", async () => {
    const root = await fresh({
      ".obsidian/templates.json": JSON.stringify({ folder: "Suggested" }),
      "Suggested/note.template.md": template,
    });

    const state = await inspectSetup({ vault: root });

    expect(state.selectedTemplateFolders).toEqual([]);
    expect(state.templateFolderSource).toBeUndefined();
    expect(state.templateFolderCandidates).toContainEqual({
      path: "Suggested",
      provenance: ["obsidian-core", "vault-walk"],
    });
    expect(state.proposal.unresolved).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_FOLDER_SELECTION_REQUIRED",
    }));
    expect(state.proposal.inputDigest).toBeUndefined();
  });

  it("keeps non-interactive setup blocked when folder selection is unresolved", async () => {
    const state = await inspectSetup({ vault: await fresh() });
    const decision = await decideNonInteractiveSetup(state);
    expect(decision.proposal.unresolved).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_FOLDER_SELECTION_REQUIRED",
    }));
    expect(decision.proposal.inputDigest).toBeUndefined();
    await expect(composeSetup(decision, { base: { fields: {} } })).rejects.toThrow("MIGRATION_UNRESOLVED_MAPPING");
  });

  it("honors a changed explicit folder choice instead of retaining the inspected choice", async () => {
    const root = await fresh({
      "First/one.md": template,
      "Second/two.md": "---\ntemplate: two\n---\nbody\n",
    });
    const state = await inspectSetup({
      vault: root,
      templateFolders: [{ path: "First", mode: "auto" }],
    });
    const decision = await decideSetup(state, {
      templateFolders: [{ path: "Second", mode: "manual", default: true }],
      registeredTemplates: [{ templateId: "two", sourcePath: "Second/two.md" }],
    });

    expect(decision.templateFolderSource).toBe("explicit");
    expect(decision.selectedTemplateFolders).toEqual([{ path: "Second", mode: "manual", default: true }]);
    expect(decision.proposal.managedSourcePaths).toEqual(["Second/two.md"]);
    expect(decision.templateFolderCandidates).toContainEqual({
      path: "Second",
      provenance: ["explicit"],
    });
  });

  it("publishes canonical model selections only after approved setup", async () => {
    const root = await fresh({
      ".obsidian/types.json": obsidianTypes,
      ".oms/taxonomy.json": taxonomy,
      ".oms/template-policy.json": savedPolicy("Templates"),
      "Templates/note.md": template,
    });
    const decision = await decideNonInteractiveSetup(await inspectSetup({
      vault: root,
      templateFolders: [{ path: "Templates", mode: "auto", default: true }],
    }));
    const manifest = await composeSetup(decision, { base: { fields: {} } });
    const receipt = await applySetup(decision, manifest, { approvedDigest: manifest.approvalDigest });

    await expect(publishSetupModels(decision, receipt, { approvedDigest: manifest.approvalDigest }, modelsConfig)).resolves.toBe(true);
    await expect(readFile(path.join(root, ".oms", "models.json"), "utf8")).resolves.toBe(`${JSON.stringify(modelsConfig, null, 2)}\n`);
  });

  it("does not publish models from a dry-run receipt", async () => {
    const root = await fresh({
      ".obsidian/types.json": obsidianTypes,
      ".oms/taxonomy.json": taxonomy,
      ".oms/template-policy.json": savedPolicy("Templates"),
      "Templates/note.md": template,
    });
    const decision = await decideNonInteractiveSetup(await inspectSetup({
      vault: root,
      templateFolders: [{ path: "Templates", mode: "auto", default: true }],
    }));
    const manifest = await composeSetup(decision, { base: { fields: {} } });
    const receipt = await applySetup(decision, manifest, { dryRun: true });

    await expect(publishSetupModels(decision, receipt, { dryRun: true }, modelsConfig)).rejects.toThrow("MIGRATION_APPROVAL_MISMATCH");
    expect(existsSync(path.join(root, ".oms", "models.json"))).toBe(false);
  });
});
