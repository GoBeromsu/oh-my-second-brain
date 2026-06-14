import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, cp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parse as yamlParse } from "yaml";
import { buildClaudeInstallPlan, runSetup, runDoctor, type SetupPrompt } from "./cli/oms.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../");
const fixtureVault = path.join(repoRoot, "test", "fixtures", "vault");

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

    expect(plan.pluginPath).toContain("adapters/claude-code");
    expect(plan.pluginInstallCommand).toContain("claude plugin install");
    expect(plan.mcpRegistrationCommand).toBe(
      "claude mcp add oms -- oms mcp --vault '/tmp/My Vault'",
    );
    expect(plan.mcpRuntimeStatus).toBe("read-status-runtime");
  });
});
