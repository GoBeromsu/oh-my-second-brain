import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ModelsConfigV1 } from "../engine/embed/config.js";
import { applySetup, composeSetup, decideNonInteractiveSetup, decideSetup, inspectSetup, publishSetupModels } from "./service.js";

let vault: string | undefined;
afterEach(async () => { if (vault !== undefined) await rm(vault, { recursive: true, force: true }); vault = undefined; });

const modelsConfig: ModelsConfigV1 = {
  schemaVersion: 1,
  embed: {
    provider: "gguf",
    model: "embeddinggemma-300m",
    revision: "v1.0.0",
    sha256: "a".repeat(64),
    promptScheme: "embeddinggemma-v1",
  },
  rerank: {
    provider: "gguf",
    model: "reranker",
    revision: "v1.0.0",
    sha256: "b".repeat(64),
  },
  generate: {
    provider: "gguf",
    model: "generator",
    revision: "v1.0.0",
    sha256: "c".repeat(64),
    promptScheme: "qmd-query-expansion-v2.8.3",
  },
};

describe("template-first setup service", () => {
  it("discovers an existing custom template folder without writing vault state", async () => {
    vault = await mkdtemp(path.join(tmpdir(), "oms-template-setup-"));
    await mkdir(path.join(vault, "My Templates", "nested"), { recursive: true });
    await writeFile(path.join(vault, "My Templates", "nested", "reading.md"), "---\ntemplate: reading\n---\n", "utf8");

    const state = await inspectSetup({ vault, templateFolder: "My Templates" });
    const decision = await decideSetup(state, { templateFolder: "My Templates" });

    expect(decision.document.questionnaire.templateFolder).toBe("My Templates");
    expect(decision.proposal.managedSourcePaths).toEqual(["My Templates/nested/reading.md"]);
    expect(existsSync(path.join(vault, ".oms"))).toBe(false);
  });

  it("publishes canonical portable model selections only after approved setup", async () => {
    vault = await mkdtemp(path.join(tmpdir(), "oms-template-setup-models-"));
    await mkdir(path.join(vault, ".obsidian"), { recursive: true });
    await writeFile(path.join(vault, ".obsidian", "types.json"), JSON.stringify({ types: { template: "string" } }), "utf8");
    const decision = await decideNonInteractiveSetup(await inspectSetup({ vault }));
    const manifest = await composeSetup(decision, { base: { fields: {} } });
    const receipt = await applySetup(decision, manifest, { approvedDigest: manifest.approvalDigest });

    await expect(publishSetupModels(decision, receipt, { approvedDigest: manifest.approvalDigest }, modelsConfig)).resolves.toBe(true);
    await expect(readFile(path.join(vault, ".oms", "models.json"), "utf8")).resolves.toBe(`${JSON.stringify(modelsConfig, null, 2)}\n`);
  });

  it("does not publish models from a dry-run receipt", async () => {
    vault = await mkdtemp(path.join(tmpdir(), "oms-template-setup-models-"));
    await mkdir(path.join(vault, ".obsidian"), { recursive: true });
    await writeFile(path.join(vault, ".obsidian", "types.json"), JSON.stringify({ types: { template: "string" } }), "utf8");
    const decision = await decideNonInteractiveSetup(await inspectSetup({ vault }));
    const manifest = await composeSetup(decision, { base: { fields: {} } });
    const receipt = await applySetup(decision, manifest, { dryRun: true });

    await expect(publishSetupModels(decision, receipt, { dryRun: true }, modelsConfig)).rejects.toThrow("MIGRATION_APPROVAL_MISMATCH");
    expect(existsSync(path.join(vault, ".oms", "models.json"))).toBe(false);
  });
});
