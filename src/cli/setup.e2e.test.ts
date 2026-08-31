import { describe, it, expect, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, cp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parse as yamlParse } from "yaml";
import {
  buildClaudeInstallPlan,
  runSetup,
  runDoctor,
  type SetupPrompt,
} from "./oms.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const fixtureVault = path.join(repoRoot, "test", "fixtures", "vault");
const gitIt = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0 ? it : it.skip;

let tmpVault: string;

class ScriptedPrompt implements SetupPrompt {
  private index = 0;

  constructor(private readonly answers: readonly string[]) {}

  async question(): Promise<string> {
    const answer = this.answers[this.index];
    if (answer === undefined) {
      throw new Error(`No scripted answer for prompt ${this.index}`);
    }
    this.index += 1;
    return answer;
  }

  close(): void {
    return;
  }

  get answered(): number {
    return this.index;
  }
}

afterAll(async () => {
  if (tmpVault) {
    await rm(tmpVault, { recursive: true, force: true });
  }
});

describe("runSetup --yes E2E", () => {
  it("creates .oms/taxonomy.yaml with version:0 and a 'references' folder binding", async () => {
    // Create a fresh temp dir and copy the fixture vault into it.
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-test-"));
    // Copy references/ and notes/ from the fixture vault.
    await cp(fixtureVault, tmpVault, { recursive: true });

    // Run setup in non-interactive mode.
    await expect(runSetup({ vault: tmpVault, yes: true })).resolves.toBeUndefined();

    // Read the written taxonomy.yaml.
    const taxonomyPath = path.join(tmpVault, ".oms", "taxonomy.yaml");
    const raw = await readFile(taxonomyPath, "utf-8");
    const parsed = yamlParse(raw) as Record<string, unknown>;

    expect(parsed["version"]).toBe(0);

    const folders = parsed["folders"] as Record<string, unknown>;
    expect(folders).toBeDefined();
    expect(folders).toHaveProperty("references");

    // The vault-local ontology must be loadable by doctor: setup writes
    // `.oms/concepts/` (mirroring core/ontology/), so the shipped concepts
    // are copied alongside taxonomy.yaml.
    const literatureCopy = path.join(tmpVault, ".oms", "concepts", "literature.yaml");
    await expect(readFile(literatureCopy, "utf-8")).resolves.toContain("concept: literature");
  });

  it("previews setup with --dry-run without creating .oms", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-test-dry-run-"));
    await cp(fixtureVault, vault, { recursive: true });

    await runSetup({ vault, yes: true, dryRun: true });

    await expect(readFile(path.join(vault, ".oms", "taxonomy.yaml"), "utf-8")).rejects.toThrow();
    await rm(vault, { recursive: true, force: true });
  });

  gitIt("ignores only the engine store and its SQLite sidecars from the nested .oms file", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-test-engine-store-ignore-"));
    try {
      await writeFile(path.join(vault, ".gitignore"), "user-root-rule\n", "utf-8");
      const init = spawnSync("git", ["init"], { cwd: vault, encoding: "utf-8" });
      expect(init.status).toBe(0);

      await runSetup({ vault, yes: true });
      await Promise.all([
        writeFile(path.join(vault, ".oms", "engine-store.sqlite"), "", "utf-8"),
        writeFile(path.join(vault, ".oms", "engine-store.sqlite-wal"), "", "utf-8"),
        writeFile(path.join(vault, ".oms", "engine-store.sqlite-shm"), "", "utf-8"),
        writeFile(path.join(vault, ".oms", "other.sqlite"), "", "utf-8"),
      ]);

      const ignored = spawnSync(
        "git",
        [
          "check-ignore",
          "-v",
          "--",
          ".oms/engine-store.sqlite",
          ".oms/engine-store.sqlite-wal",
          ".oms/engine-store.sqlite-shm",
        ],
        { cwd: vault, encoding: "utf-8" },
      );
      expect(ignored.status).toBe(0);
      expect(ignored.stdout).toContain(".oms/.gitignore");
      expect(ignored.stdout).toContain("/engine-store.sqlite*");

      const other = spawnSync("git", ["check-ignore", "-q", "--", ".oms/other.sqlite"], {
        cwd: vault,
        encoding: "utf-8",
      });
      expect(other.status).toBe(1);
      await expect(readFile(path.join(vault, ".gitignore"), "utf-8")).resolves.toBe("user-root-rule\n");
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it("installs a strict three-capability model set and writes only its portable vault config", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-test-model-"));
    const cacheDir = await mkdtemp(path.join(tmpdir(), "oms-test-model-cache-"));
    const bytes = new TextEncoder().encode("verified model bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    try {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await runSetup({
        vault,
        yes: true,
        modelCacheDir: cacheDir,
        modelSetManifest: {
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
            promptScheme: "qmd-query-expansion-v2.8.3",
            url: "https://models.invalid/generate.gguf", filename: "generate.gguf",
          },
        },
        modelFetchImpl: async () => new Response(bytes),
      });
      const output = log.mock.calls.flat().join("\n");
      log.mockRestore();
      const installed = JSON.parse(
        await readFile(path.join(cacheDir, "installed-models.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(installed["artifacts"]).toHaveLength(3);
      await expect(readFile(path.join(vault, ".oms", "models.json"), "utf-8")).resolves.toBe(
        `${JSON.stringify({
          schemaVersion: 1,
          embed: { provider: "gguf", model: "embed.gguf", revision: "embed-v1", sha256, promptScheme: "embeddinggemma-v1" },
          rerank: { provider: "gguf", model: "rerank.gguf", revision: "rerank-v1", sha256 },
          generate: { provider: "gguf", model: "generate.gguf", revision: "generate-v1", sha256, promptScheme: "qmd-query-expansion-v2.8.3" },
        }, null, 2)}\n`,
      );
      expect(JSON.stringify(installed)).not.toContain(path.resolve(vault));
      expect(output).toContain("Model: embed gguf/embed.gguf@embed-v1");
      expect(output).toContain("Model: rerank gguf/rerank.gguf@rerank-v1");
      expect(output).toContain("Model: generate gguf/generate.gguf@generate-v1");
      expect(output).toContain("Written:  .oms/models.json");
      expect(output).not.toContain(cacheDir);
      expect(output).not.toContain("https://");
    } finally {
      await rm(vault, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("does not fetch or write model state during a dry-run", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-test-model-dry-run-"));
    const cacheDir = path.join(vault, "model-cache");
    let fetches = 0;
    const manifest = {
      schemaVersion: 1,
      embed: {
        provider: "gguf", model: "embed.gguf", revision: "embed-v1", sha256: "a".repeat(64),
        promptScheme: "embeddinggemma-v1", url: "https://models.invalid/embed.gguf",
        dimensions: 384, contextLength: 1024, mrlDim: 384, normalization: "l2",
      },
    };
    try {
      await runSetup({
        vault, yes: true, dryRun: true, modelCacheDir: cacheDir, modelSetManifest: manifest,
        modelFetchImpl: async () => { fetches += 1; return new Response("unexpected"); },
      });
      expect(fetches).toBe(0);
      await expect(readFile(path.join(vault, ".oms", "models.json"), "utf-8")).rejects.toThrow();
      await expect(readFile(path.join(cacheDir, "installed-models.json"), "utf-8")).rejects.toThrow();
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it("preserves existing models config when the explicit no-default waiver is used", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-test-no-default-"));
    const existing = "{\"user\":\"owned\"}\n";
    try {
      await mkdir(path.join(vault, ".oms"), { recursive: true });
      await writeFile(path.join(vault, ".oms", "models.json"), existing, "utf-8");
      await runSetup({ vault, yes: true, modelsNoDefault: true });
      await expect(readFile(path.join(vault, ".oms", "models.json"), "utf-8")).resolves.toBe(existing);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it("rejects strict legacy manifest fields before setup writes files", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-test-model-legacy-"));
    const manifest = {
      schemaVersion: 1,
      embed: {
        provider: "gguf", model: "descriptor-model", revision: "test-revision", dimensions: 384,
        context: 1024, mrlDim: 384, normalization: "l2", promptScheme: "embeddinggemma-v1",
        url: "https://models.invalid/descriptor.gguf", sha256: "a".repeat(64),
      },
    };
    try {
      await expect(
        runSetup({ vault, yes: true, modelSetManifest: manifest }),
      ).rejects.toThrow('Invalid installed-models.json: manifest.embed contains unknown key "context".');
      await expect(readFile(path.join(vault, ".oms", "taxonomy.yaml"), "utf-8")).rejects.toThrow();
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it("rejects malformed model manifests before setup writes files", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-test-model-malformed-"));
    try {
      await expect(runSetup({ vault, yes: true, modelSetManifest: "{not json" })).rejects.toThrow(
        "Invalid installed-models.json: acquisition manifest is not valid JSON.",
      );
      await expect(readFile(path.join(vault, ".oms", "taxonomy.yaml"), "utf-8")).rejects.toThrow();
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it("doctor runs against the freshly set-up vault and exits 0", async () => {
    // Regression guard: setup's vault-local layout (.oms/taxonomy.yaml +
    // .oms/concepts/) must be exactly what doctor's loadOntology consumes.
    const code = await runDoctor({ vault: tmpVault });
    expect(code).toBe(0);
  });

  it("preserves existing concept files and only writes observed fields when --suggest-fields is requested", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-test-preserve-"));
    await cp(fixtureVault, vault, { recursive: true });
    const notePath = path.join(vault, "references", "clean-architecture.md");
    const noteBefore = await readFile(notePath, "utf-8");

    await runSetup({ vault, yes: true });
    const literaturePath = path.join(vault, ".oms", "concepts", "literature.yaml");
    const customized = [
      "concept: literature",
      "intent: Custom literature concept",
      "folder: references",
      "aliases:",
      "  - source",
      "customTop:",
      "  owner: user",
      "fields:",
      "  - name: title",
      "    type: string",
      "    required: true",
      "    intent: Existing title field",
      "  - name: custom-note",
      "    type: string",
      "    required: false",
      "    intent: User-owned custom field",
      "lenses: []",
      "",
    ].join("\n");
    await writeFile(literaturePath, customized, "utf-8");

    await runSetup({ vault, yes: true, suggestFields: true });

    const noteAfter = await readFile(notePath, "utf-8");
    const literature = await readFile(literaturePath, "utf-8");
    expect(noteAfter).toBe(noteBefore);
    expect(literature).toContain("Custom literature concept");
    expect(literature).toContain("custom-note");
    expect(literature).toContain("source-url");
    const parsedConcept = yamlParse(literature) as Record<string, unknown>;
    expect(parsedConcept["aliases"]).toEqual(["source"]);
    expect(parsedConcept["customTop"]).toEqual({ owner: "user" });

    await rm(vault, { recursive: true, force: true });
  });

  it("accepts interactive lenses that reference existing local concept fields", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-test-interactive-lens-"));
    await cp(fixtureVault, vault, { recursive: true });
    await rm(path.join(vault, "notes"), { recursive: true, force: true });
    const notePath = path.join(vault, "references", "clean-architecture.md");
    const noteBefore = await readFile(notePath, "utf-8");
    const omsDir = path.join(vault, ".oms");
    await mkdir(path.join(omsDir, "concepts"), { recursive: true });
    await writeFile(
      path.join(omsDir, "taxonomy.yaml"),
      [
        "version: 0",
        "folders:",
        "  references:",
        "    intent: References",
        "    concept: literature",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      path.join(omsDir, "concepts", "literature.yaml"),
      [
        "concept: literature",
        "intent: Custom literature concept",
        "folder: references",
        "customTop:",
        "  owner: user",
        "fields:",
        "  - name: custom-note",
        "    type: string",
        "    required: false",
        "    intent: Existing local field",
        "lenses: []",
        "",
      ].join("\n"),
      "utf-8",
    );

    const prompt = new ScriptedPrompt(["", "", "", "custom:custom-note"]);

    await expect(runSetup({ vault, yes: false, suggestFields: true, prompt })).resolves.toBeUndefined();

    const noteAfter = await readFile(notePath, "utf-8");
    const literature = yamlParse(
      await readFile(path.join(omsDir, "concepts", "literature.yaml"), "utf-8"),
    ) as Record<string, unknown>;
    expect(noteAfter).toBe(noteBefore);
    expect(prompt.answered).toBe(4);
    expect(literature["customTop"]).toEqual({ owner: "user" });
    expect(literature["lenses"]).toEqual([
      {
        name: "custom",
        intent: "Retrieval lens for custom.",
        fields: ["custom-note"],
      },
    ]);

    await rm(vault, { recursive: true, force: true });
  });

  it("builds a Claude Code install plan that only claims the read/status MCP runtime", () => {
    const plan = buildClaudeInstallPlan({ vault: "/tmp/My Vault" });

    // The plugin root is the package root since the vendor topology move, so
    // the plan points at the root manifest rather than a vendor subdirectory.
    expect(plan.pluginPath).not.toContain("adapters/claude-code");
    expect(plan.pluginInstallCommand).toContain("claude plugin install");
    expect(plan.pluginMcpAsset).toContain(".mcp.json");
    expect(plan.pluginMcpAsset).not.toContain("adapters/");
    expect(plan.mcpRuntimeStatus).toBe("read-status-runtime");
  });
});
