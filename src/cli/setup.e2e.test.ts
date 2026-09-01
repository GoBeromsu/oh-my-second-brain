import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { composeSetup, decideNonInteractiveSetup, inspectSetup } from "../kernel/setup/service.js";
import { runSetup } from "./setup-command.js";

let vault: string | undefined;
afterEach(async () => { if (vault !== undefined) await rm(vault, { recursive: true, force: true }); vault = undefined; });
async function fresh(): Promise<string> { vault = await mkdtemp(path.join(tmpdir(), "oms-setup-")); return vault; }
async function authority(root: string): Promise<void> { await mkdir(path.join(root, ".obsidian"), { recursive: true }); await writeFile(path.join(root, ".obsidian", "types.json"), JSON.stringify({ types: { template: "string" } })); }
async function noteTemplate(root: string): Promise<void> { await mkdir(path.join(root, "Templates"), { recursive: true }); await writeFile(path.join(root, "Templates", "note.md"), "---\ntemplate: note\n---\nbody\n"); }

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");

function runSetupCli(args: readonly string[]) {
  if (!existsSync(distCli)) {
    throw new Error("dist/cli/oms.js is missing; run npm run build before setup CLI tests.");
  }
  return spawnSync(process.execPath, [distCli, "setup", ...args], {
    cwd: repoRoot,
    env: { ...process.env, OMS_UPDATE_NOTICE: "0", OMS_NO_UPDATE_NOTICE: "1" },
    encoding: "utf-8",
  });
}

function modelManifest(sha256: string): object {
  return {
    schemaVersion: 1,
    embed: {
      provider: "gguf", model: "embed.gguf", revision: "embed-v1", sha256,
      promptScheme: "embeddinggemma-v1", url: "https://models.invalid/embed.gguf",
      filename: "embed.gguf", dimensions: 384, contextLength: 1024, mrlDim: 384, normalization: "l2",
    },
    rerank: {
      provider: "gguf", model: "rerank.gguf", revision: "rerank-v1", sha256,
      url: "https://models.invalid/rerank.gguf", filename: "rerank.gguf",
    },
    generate: {
      provider: "gguf", model: "generate.gguf", revision: "generate-v1", sha256,
      promptScheme: "qmd-query-expansion-v2.8.3", url: "https://models.invalid/generate.gguf",
      filename: "generate.gguf",
    },
  };
}

async function approval(root: string): Promise<`sha256:${string}`> {
  const state = await inspectSetup({ vault: root });
  return (await composeSetup(await decideNonInteractiveSetup(state), { base: { fields: {} } })).approvalDigest;
}

describe("template-first setup", () => {
  it("rejects invalid setup options before dry-run or writes", async () => {
    const root = await fresh();
    await authority(root);
    const invalidCases = [
      ["--embedding-default"],
      ["--embedding-no-default"],
      ["--embedding-descriptor", "legacy.json"],
      ["--unknown-setup-option"],
      ["--models-descriptor"],
      ["--models-default", "--models-descriptor", "models.json"],
      ["--models-default", "--models-no-default"],
      ["--models-descriptor", "models.json", "--models-no-default"],
    ];

    for (const args of invalidCases) {
      const result = runSetupCli(["--vault", root, "--dry-run", ...args]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--models-default");
      expect(result.stderr).toContain("--models-descriptor <path>");
      expect(result.stderr).toContain("--models-no-default");
      expect(existsSync(path.join(root, ".oms"))).toBe(false);
    }
  });

  it("accepts shared setup flags without writing during a template-first dry-run", async () => {
    const root = await fresh();
    await authority(root);
    const result = runSetupCli([
      "--vault", root,
      "--runtime", "hermes",
      "--agent-vault", "AgentVault",
      "--dry-run",
      "--execute",
      "--yes",
      "--approved-digest", "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "--install-claude",
      "--models-no-default",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(path.join(root, ".oms"))).toBe(false);
  });

  it("dry-runs empty discovery without mutation", async () => {
    const root = await fresh(); await authority(root);
    await runSetup({ vault: root, yes: true, dryRun: true });
    expect(existsSync(path.join(root, ".oms"))).toBe(false);
  });

  it("blocks unresolved notes before composing a setup manifest and emits no digest", async () => {
    const root = await fresh();
    await authority(root);
    await mkdir(path.join(root, "Notes"), { recursive: true });
    await writeFile(path.join(root, "Notes", "broken.md"), "---\ntitle: [unterminated\n---\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runSetup({ vault: root, yes: true, dryRun: true });
      const output = log.mock.calls.map(call => call.join(" ")).join("\n");
      expect(output).toContain('"status": "blocked"');
      expect(output).toContain("MIGRATION_NOTE_INVALID");
      expect(output).not.toContain("inputDigest");
      expect(output).not.toContain("approvalDigest");
      expect(output).not.toContain("outputDigest");
      expect(existsSync(path.join(root, ".oms"))).toBe(false);
    } finally {
      log.mockRestore();
      process.exitCode = undefined;
    }
  });

  it("dry-runs configured external template sources without adopting them", async () => {
    const root = await fresh();
    await authority(root);
    await noteTemplate(root);
    await mkdir(path.join(root, "External", "Templater"), { recursive: true });
    await writeFile(path.join(root, "External", "Templater", "source.template.md"), "{{ unsupported }}\n");
    await mkdir(path.join(root, ".obsidian", "plugins", "templater-obsidian"), { recursive: true });
    await writeFile(path.join(root, ".obsidian", "templates.json"), JSON.stringify({ folder: "External/Obsidian" }));
    await writeFile(path.join(root, ".obsidian", "plugins", "templater-obsidian", "data.json"), JSON.stringify({
      templates_folder: "External/Templater",
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runSetup({ vault: root, yes: true, dryRun: true });
      const output = log.mock.calls.map(call => call.join(" ")).join("\n");
      expect(output).toContain("inputDigest");
      expect(output).toContain("approvalDigest");
      expect(output).toContain("outputDigest");
      expect(output).not.toContain("External/Templater/source.template.md");
    } finally {
      log.mockRestore();
    }
  });

  it("fails loudly without Obsidian type authority", async () => {
    const root = await fresh(); await noteTemplate(root);
    await expect(runSetup({ vault: root, yes: true, dryRun: true })).rejects.toThrow("MIGRATION_CONTROL_MISSING");
  });

  it("requires a shown digest and publishes through the guarded transaction", async () => {
    const root = await fresh(); await authority(root); await noteTemplate(root);
    const digest = await approval(root);
    await expect(runSetup({ vault: root, yes: true })).rejects.toThrow("approvedDigest");
    let downloads = 0;
    await expect(runSetup({
      vault: root,
      yes: true,
      approvedDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      modelSetManifest: modelManifest("0".repeat(64)),
      modelFetchImpl: async () => { downloads += 1; return new Response(); },
    })).rejects.toThrow("MIGRATION_APPROVAL_MISMATCH");
    expect(downloads).toBe(0);
    await runSetup({ vault: root, yes: true, approvedDigest: digest });
    await expect(readFile(path.join(root, ".oms", "template-policy.json"), "utf8")).resolves.toContain("note");
    await expect(readFile(path.join(root, ".oms", "types.json"), "utf8")).resolves.toContain("oms.types.v1");
    await expect(readFile(path.join(root, ".oms", "template-migration.json"), "utf8")).resolves.toContain("complete");
  });

  it("acquires a complete capability set during approved setup and publishes portable selections", async () => {
    const root = await fresh(); await authority(root); await noteTemplate(root);
    const cacheDir = await mkdtemp(path.join(tmpdir(), "oms-model-cache-"));
    const bytes = new TextEncoder().encode("model bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runSetup({
        vault: root,
        yes: true,
        approvedDigest: await approval(root),
        modelCacheDir: cacheDir,
        modelSetManifest: modelManifest(sha256),
        modelFetchImpl: async () => new Response(bytes),
      });
      const config = await readFile(path.join(root, ".oms", "models.json"), "utf8");
      const installed = await readFile(path.join(cacheDir, "installed-models.json"), "utf8");
      expect(config).toContain('"rerank"');
      expect(config).toContain('"generate"');
      expect(config).not.toContain("https://");
      expect(installed).toContain('"artifacts"');
      expect(log.mock.calls.flat().join("\n")).toContain("Model: generate gguf/generate.gguf@generate-v1");
    } finally {
      log.mockRestore();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("does not fetch or write model state during a dry-run", async () => {
    const root = await fresh(); await authority(root);
    const cacheDir = path.join(root, "model-cache");
    let fetches = 0;
    await runSetup({
      vault: root,
      yes: true,
      dryRun: true,
      modelCacheDir: cacheDir,
      modelSetManifest: modelManifest("a".repeat(64)),
      modelFetchImpl: async () => { fetches += 1; return new Response("unexpected"); },
    });
    expect(fetches).toBe(0);
    expect(existsSync(path.join(root, ".oms", "models.json"))).toBe(false);
    expect(existsSync(path.join(cacheDir, "installed-models.json"))).toBe(false);
  });

  it("preserves existing models configuration with the explicit no-default waiver", async () => {
    const root = await fresh(); await authority(root);
    const existing = "{\"user\":\"owned\"}\n";
    await mkdir(path.join(root, ".oms"), { recursive: true });
    await writeFile(path.join(root, ".oms", "models.json"), existing, "utf8");
    await runSetup({ vault: root, yes: true, approvedDigest: await approval(root), modelsNoDefault: true });
    await expect(readFile(path.join(root, ".oms", "models.json"), "utf8")).resolves.toBe(existing);
  });

  it("rejects malformed model manifests before setup writes files", async () => {
    const root = await fresh(); await authority(root);
    await expect(runSetup({ vault: root, yes: true, approvedDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000", modelSetManifest: "{not json" })).rejects.toThrow("Invalid installed-models.json: acquisition manifest is not valid JSON.");
    expect(existsSync(path.join(root, ".oms", "template-policy.json"))).toBe(false);
  });

  it("given a configured template folder, when setup runs, then discovery and policy use it", async () => {
    const root = await fresh();
    await authority(root);
    await writeFile(path.join(root, ".obsidian", "types.json"), JSON.stringify({ types: { template: "string", title: "string" } }));
    await mkdir(path.join(root, "Meta", "Templates"), { recursive: true });
    await writeFile(path.join(root, "Meta", "Templates", "custom.md"), "---\ntitle: Untitled\n---\n# Custom\n", "utf8");
    const state = await inspectSetup({ vault: root, templateFolder: "Meta/Templates" });
    const manifest = await composeSetup(await decideNonInteractiveSetup(state), { base: { fields: {} } });

    await runSetup({ vault: root, yes: true, templateFolder: "Meta/Templates", approvedDigest: manifest.approvalDigest });
    await expect(readFile(path.join(root, ".oms", "template-policy.json"), "utf8")).resolves.toContain('"templateFolder": "Meta/Templates"');
  });
});
