import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelsConfigV1 } from "../engine/embed/config.js";
import { applySetup, decideNonInteractiveSetup, inspectSetup } from "./service.js";

let vault: string | undefined;
const modelsConfig: ModelsConfigV1 = {
  schemaVersion: 1,
  embed: {
    provider: "gguf",
    model: "embeddinggemma-300m",
    revision: "v1.0.0",
    sha256: "a".repeat(64),
    promptScheme: "embeddinggemma-v1",
  },
};

afterEach(async () => {
  if (vault !== undefined) await rm(vault, { recursive: true, force: true });
  vault = undefined;
});

describe("setup service", () => {
  async function applyToVault(initialGitignore?: string): Promise<string> {
    vault = await mkdtemp(path.join(tmpdir(), "oms-setup-service-"));
    if (initialGitignore !== undefined) {
      await mkdir(path.join(vault, ".oms"), { recursive: true });
      await writeFile(path.join(vault, ".oms", ".gitignore"), initialGitignore, "utf-8");
    }
    const state = await inspectSetup({ vault, ontologyDir: path.resolve("core/ontology") });
    await applySetup(decideNonInteractiveSetup(state, false));
    return readFile(path.join(vault, ".oms", ".gitignore"), "utf-8");
  }

  it("resolves non-interactive bindings and previews persistence without writing", async () => {
    vault = await mkdtemp(path.join(tmpdir(), "oms-setup-service-"));
    await mkdir(path.join(vault, "references"));
    await writeFile(path.join(vault, "references", "source.md"), "---\nsource-url: https://example.test\n---\n", "utf-8");
    const state = await inspectSetup({ vault, ontologyDir: path.resolve("core/ontology") });
    const decision = decideNonInteractiveSetup(state, true);

    expect(decision.taxonomy).toEqual({ version: 0, folders: { references: { intent: "References", concept: "literature" } } });
    expect(decision.concepts.find(({ concept }) => concept.concept === "literature")?.concept.fields.map((field) => field.name)).toContain("source-url");

    await applySetup(decision, { dryRun: true });
    expect(existsSync(path.join(vault, ".oms"))).toBe(false);

    await applySetup(decision);
    expect(await readFile(path.join(vault, ".oms", "taxonomy.yaml"), "utf-8")).toContain("references:");
    expect(await readFile(path.join(vault, ".oms", "concepts", "literature.yaml"), "utf-8")).toContain("source-url");
  });

  it("creates the nested engine-store ignore block without touching the vault root", async () => {
    expect(await applyToVault()).toBe(
      "# Oh My Second Brain engine store (managed)\n/engine-store.sqlite*\n",
    );
    expect(existsSync(path.join(vault!, ".gitignore"))).toBe(false);
  });

  it("preserves LF user lines while adding the managed block", async () => {
    expect(await applyToVault("node_modules/\ncoverage/\n")).toBe(
      "node_modules/\ncoverage/\n# Oh My Second Brain engine store (managed)\n/engine-store.sqlite*\n",
    );
  });

  it("preserves CRLF user lines while adding the managed block", async () => {
    expect(await applyToVault("node_modules/\r\ncoverage/\r\n")).toBe(
      "node_modules/\r\ncoverage/\r\n# Oh My Second Brain engine store (managed)\r\n/engine-store.sqlite*\r\n",
    );
  });

  it("preserves a missing final newline while adding the managed block", async () => {
    expect(await applyToVault("node_modules/")).toBe(
      "node_modules/\n# Oh My Second Brain engine store (managed)\n/engine-store.sqlite*",
    );
  });

  it("converges a comment-only managed entry without duplicating it", async () => {
    const content = await applyToVault(
      "user-rule\n# Oh My Second Brain engine store (managed)\n",
    );
    expect(content).toBe(
      "user-rule\n# Oh My Second Brain engine store (managed)\n/engine-store.sqlite*\n",
    );
    expect(content.match(/Oh My Second Brain engine store/g)).toHaveLength(1);
  });

  it("converges a pattern-only managed entry without duplicating it", async () => {
    const content = await applyToVault("user-rule\n/engine-store.sqlite*\n");
    expect(content).toBe(
      "user-rule\n# Oh My Second Brain engine store (managed)\n/engine-store.sqlite*\n",
    );
    expect(content.match(/^\/engine-store\.sqlite\*$/gm)).toHaveLength(1);
  });

  it("is byte-identical on a second setup", async () => {
    await applyToVault("user-rule\n");
    const first = await readFile(path.join(vault!, ".oms", ".gitignore"));
    const state = await inspectSetup({ vault: vault!, ontologyDir: path.resolve("core/ontology") });
    await applySetup(decideNonInteractiveSetup(state, false));
    await expect(readFile(path.join(vault!, ".oms", ".gitignore"))).resolves.toEqual(first);
  });

  it("does not create the nested ignore file during dry-run", async () => {
    vault = await mkdtemp(path.join(tmpdir(), "oms-setup-service-dry-run-"));
    const state = await inspectSetup({ vault, ontologyDir: path.resolve("core/ontology") });

    const receipt = await applySetup(decideNonInteractiveSetup(state, false), { dryRun: true });

    expect(receipt.engineStoreGitignoreUpdated).toBe(false);
    expect(existsSync(path.join(vault, ".oms", ".gitignore"))).toBe(false);
  });

  it("writes a strictly parsed canonical models configuration", async () => {
    vault = await mkdtemp(path.join(tmpdir(), "oms-setup-service-models-"));
    const state = await inspectSetup({ vault, ontologyDir: path.resolve("core/ontology") });
    const uncanonical = {
      embed: {
        sha256: modelsConfig.embed.sha256,
        promptScheme: modelsConfig.embed.promptScheme,
        revision: modelsConfig.embed.revision,
        model: modelsConfig.embed.model,
        provider: modelsConfig.embed.provider,
      },
      schemaVersion: 1,
    } as ModelsConfigV1;

    const receipt = await applySetup(decideNonInteractiveSetup(state, false), { modelsConfig: uncanonical });

    expect(receipt.modelsConfigUpdated).toBe(true);
    await expect(readFile(path.join(vault, ".oms", "models.json"), "utf-8")).resolves.toBe(
      `${JSON.stringify(modelsConfig, null, 2)}\n`,
    );
  });

  it("rejects malformed models configuration before writing it", async () => {
    vault = await mkdtemp(path.join(tmpdir(), "oms-setup-service-models-"));
    const state = await inspectSetup({ vault, ontologyDir: path.resolve("core/ontology") });

    await expect(applySetup(decideNonInteractiveSetup(state, false), {
      modelsConfig: { ...modelsConfig, unknown: true } as ModelsConfigV1,
    })).rejects.toThrow('top level contains unknown key "unknown"');
    expect(existsSync(path.join(vault, ".oms", "models.json"))).toBe(false);
  });

  it("does not rewrite an identical models configuration", async () => {
    vault = await mkdtemp(path.join(tmpdir(), "oms-setup-service-models-"));
    const state = await inspectSetup({ vault, ontologyDir: path.resolve("core/ontology") });
    const decision = decideNonInteractiveSetup(state, false);
    await applySetup(decision, { modelsConfig });
    const first = await readFile(path.join(vault, ".oms", "models.json"));

    const receipt = await applySetup(decision, { modelsConfig });

    expect(receipt.modelsConfigUpdated).toBe(false);
    await expect(readFile(path.join(vault, ".oms", "models.json"))).resolves.toEqual(first);
  });

  it("replaces a changed models configuration", async () => {
    vault = await mkdtemp(path.join(tmpdir(), "oms-setup-service-models-"));
    const state = await inspectSetup({ vault, ontologyDir: path.resolve("core/ontology") });
    const decision = decideNonInteractiveSetup(state, false);
    await applySetup(decision, { modelsConfig });
    const changed = { ...modelsConfig, embed: { ...modelsConfig.embed, revision: "v1.0.1" } };

    const receipt = await applySetup(decision, { modelsConfig: changed });

    expect(receipt.modelsConfigUpdated).toBe(true);
    await expect(readFile(path.join(vault, ".oms", "models.json"), "utf-8")).resolves.toBe(
      `${JSON.stringify(changed, null, 2)}\n`,
    );
  });

  it("preserves user-owned models configuration when no configuration is supplied", async () => {
    vault = await mkdtemp(path.join(tmpdir(), "oms-setup-service-models-"));
    const existing = "{ user-owned bytes }\n";
    await mkdir(path.join(vault, ".oms"), { recursive: true });
    await writeFile(path.join(vault, ".oms", "models.json"), existing, "utf-8");
    const state = await inspectSetup({ vault, ontologyDir: path.resolve("core/ontology") });

    const receipt = await applySetup(decideNonInteractiveSetup(state, false));

    expect(receipt.modelsConfigUpdated).toBe(false);
    await expect(readFile(path.join(vault, ".oms", "models.json"), "utf-8")).resolves.toBe(existing);
  });

  it("plans models configuration updates during dry-run without writing", async () => {
    vault = await mkdtemp(path.join(tmpdir(), "oms-setup-service-models-"));
    const state = await inspectSetup({ vault, ontologyDir: path.resolve("core/ontology") });
    const decision = decideNonInteractiveSetup(state, false);

    await expect(applySetup(decision, { dryRun: true, modelsConfig })).resolves.toMatchObject({
      modelsConfigUpdated: true,
    });
    expect(existsSync(path.join(vault, ".oms", "models.json"))).toBe(false);

    await mkdir(path.join(vault, ".oms"), { recursive: true });
    await writeFile(path.join(vault, ".oms", "models.json"), `${JSON.stringify(modelsConfig, null, 2)}\n`, "utf-8");
    await expect(applySetup(decision, { dryRun: true, modelsConfig })).resolves.toMatchObject({
      modelsConfigUpdated: false,
    });
    await expect(readFile(path.join(vault, ".oms", "models.json"), "utf-8")).resolves.toBe(
      `${JSON.stringify(modelsConfig, null, 2)}\n`,
    );
  });
});
