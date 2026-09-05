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
async function authority(root: string): Promise<void> {
  await mkdir(path.join(root, ".obsidian"), { recursive: true });
  await mkdir(path.join(root, ".oms"), { recursive: true });
  await writeFile(path.join(root, ".obsidian", "types.json"), JSON.stringify({
    types: { template: "text", title: "text" },
  }));
  await writeFile(path.join(root, ".oms", "taxonomy.json"), JSON.stringify({
    folders: {},
    templates: {
      note: { templateFolder: "Notes" },
      daily: { templateFolder: "Journal" },
    },
  }));
}
async function template(root: string, folder = "Templates", templateId = "note"): Promise<void> {
  await mkdir(path.join(root, folder), { recursive: true });
  await writeFile(
    path.join(root, folder, `${templateId}.md`),
    `---\ntemplate: ${templateId}\ntitle: Untitled\n---\nbody\n`,
  );
}

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

async function approval(
  root: string,
  templateFolders: readonly string[] = ["Templates"],
): Promise<`sha256:${string}`> {
  const state = await inspectSetup({
    vault: root,
    templateFolders: templateFolders.map((folder, index) => ({
      path: folder,
      mode: "auto",
      ...(index === 0 ? { default: true as const } : {}),
    })),
  });
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
      expect(existsSync(path.join(root, ".oms", "template-policy.json"))).toBe(false);
    }
  });

  it("accepts shared setup flags without writing during a template-first dry-run", async () => {
    const root = await fresh();
    await authority(root);
    await template(root);
    await template(root, "Team/Templates", "daily");
    const result = runSetupCli([
      "--vault", root,
      "--template-folder", "Templates",
      "--template-folder", "Team/Templates",
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
    expect(result.stdout).toContain('"path": "Templates"');
    expect(result.stdout).toContain('"path": "Team/Templates"');
    expect(existsSync(path.join(root, ".oms", "template-policy.json"))).toBe(false);
  });

  it("dry-runs a mixed folder with per-file diagnostics and only compatible candidates", async () => {
    const root = await fresh(); await authority(root); await template(root);
    await writeFile(path.join(root, "Templates", "mail.template.md"), "---\nsubject: <% tp.file.title %>\n---\nbody\n");
    await writeFile(path.join(root, "Templates", "zt-cite.eta.md"), "<%= it.title %>\n");
    await writeFile(path.join(root, ".oms", "taxonomy.json"), JSON.stringify({ folders: {}, templates: { note: { templateFolder: "Notes" }, mail: { templateFolder: "Mail" } } }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await runSetup({ vault: root, yes: true, dryRun: true, templateFolders: ["Templates"] })).toBe("completed");
      const shown = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(shown.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "FIELD_FILLED_BY_OBSIDIAN", path: "Templates/mail.template.md", field: "subject" }),
        expect.objectContaining({ code: "TEMPLATE_CONTRACT_UNOBSERVED", path: "Templates/zt-cite.eta.md" }),
      ]));
      expect(shown.templateCandidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ templateId: "mail", renderer: "templater", filledBy: ["subject"], samples: 0, coverage: {}, selected: true }),
        expect.objectContaining({ templateId: "zt-cite", renderer: "none", samples: 0, coverage: {}, selected: false }),
      ]));
      expect(shown.receipt.operations.map((item: { templateId: string }) => item.templateId)).toEqual(["mail", "note"]);
      expect(shown.starterTemplates).toEqual([]);
      expect(process.exitCode ?? 0).toBe(0);
    } finally { log.mockRestore(); }
  });

  it("round-trips an approved Templater proposal with source signatures and no execution", async () => {
    const root = await fresh(); await authority(root);
    await mkdir(path.join(root, "Templates"), { recursive: true });
    const source = "---\ntemplate: mail\nsubject: <% tp.file.title %>\n---\nbody\n";
    await writeFile(path.join(root, "Templates", "mail.md"), source);
    await writeFile(path.join(root, ".oms", "taxonomy.json"), JSON.stringify({ folders: {}, templates: { mail: { templateFolder: "Mail" } } }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await runSetup({ vault: root, yes: true, dryRun: true, templateFolders: ["Templates"] })).toBe("completed");
      const shown = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(shown.templateCandidates).toContainEqual(expect.objectContaining({ templateId: "mail", renderer: "templater", filledBy: ["subject"], selected: true }));
      expect(shown.policyProposal.templates.mail).toMatchObject({ renderer: "templater", sourcePath: "Templates/mail.md" });
      expect(shown.receipt.status).toBe("planned");
      log.mockClear();
      expect(await runSetup({ vault: root, yes: true, templateFolders: ["Templates"], approvedDigest: shown.approvalDigest })).toBe("completed");
      expect(await readFile(path.join(root, "Templates", "mail.md"), "utf8")).toBe(source);
      const projectionText = await readFile(path.join(root, ".oms", "types.json"), "utf8");
      const projection = JSON.parse(projectionText);
      expect(projection.generatedFrom.sources).toContainEqual(expect.objectContaining({ path: "Templates/mail.md", signature: expect.stringMatching(/^sha256:/) }));
      expect(projection.managed.templates.mail).toMatchObject({ renderer: "templater", fields: { subject: { filledBy: "obsidian" } } });
      expect(projectionText).not.toContain("<%");
    } finally { log.mockRestore(); }
  });

  it("creates an approved starter template for an empty default folder", async () => {
    const root = await fresh(); await authority(root);
    await mkdir(path.join(root, "Templates"), { recursive: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await runSetup({ vault: root, yes: true, dryRun: true, templateFolders: ["Templates"] })).toBe("completed");
      const shown = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(shown.starterTemplates).toEqual(["Templates/note.md"]);
      expect(existsSync(path.join(root, "Templates", "note.md"))).toBe(false);
      await runSetup({ vault: root, yes: true, templateFolders: ["Templates"], approvedDigest: shown.approvalDigest });
      expect(await readFile(path.join(root, "Templates", "note.md"), "utf8")).toBe("---\ntemplate: note\n---\n<!-- oms:content -->\n");
      await expect(readFile(path.join(root, ".oms", "template-policy.json"), "utf8")).resolves.toContain('"sourcePath": "Templates/note.md"');
    } finally { log.mockRestore(); }
  });

  it("shows the full replacement policy and its observed preimage without publishing", async () => {
    const root = await fresh(); await authority(root); await template(root);
    const original = JSON.stringify({ version: 1, templateFolder: "Old", writers: { field: "author", identifiers: ["human"] }, personal: { keep: true } });
    await writeFile(path.join(root, ".oms", "template-policy.json"), original);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await runSetup({ vault: root, yes: true, dryRun: true, templateFolders: ["Templates"] })).toBe("completed");
      const shown = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(shown.policyProposal).toMatchObject({ version: 3, writers: { field: "author", identifiers: ["human"] }, extensions: { personal: { keep: true } } });
      expect(shown.policyPreimage).toMatchObject({ state: "present", signature: expect.stringMatching(/^sha256:/) });
      expect(shown.droppedKeys).toEqual(["templateFolder", "version"]);
      expect(await readFile(path.join(root, ".oms", "template-policy.json"), "utf8")).toBe(original);
    } finally { log.mockRestore(); }
  });

  it("does not advertise approval when transaction admission rejects its dry-run", async () => {
    const root = await fresh(); await authority(root); await template(root);
    await writeFile(path.join(root, ".oms", "template-migration.json"), "invalid marker");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await runSetup({ vault: root, yes: true, dryRun: true, templateFolders: ["Templates"] })).toBe("blocked");
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("migration-incomplete");
      expect(output).not.toContain("approvalDigest");
      expect(existsSync(path.join(root, ".oms", "template-policy.json"))).toBe(false);
      expect(await readFile(path.join(root, ".oms", "template-migration.json"), "utf8")).toBe("invalid marker");
    } finally { log.mockRestore(); process.exitCode = undefined; }
  });

  it("blocks an unselected non-interactive setup without mutation or digests", async () => {
    const root = await fresh(); await authority(root);
    const taxonomy = await readFile(path.join(root, ".oms", "taxonomy.json"), "utf8");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runSetup({ vault: root, yes: true, dryRun: true })).resolves.toBe("blocked");
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("TEMPLATE_FOLDER_SELECTION_REQUIRED");
      expect(output).not.toContain("inputDigest");
      expect(output).not.toContain("approvalDigest");
      expect(output).not.toContain("outputDigest");
      expect(existsSync(path.join(root, ".oms", "template-policy.json"))).toBe(false);
      await expect(readFile(path.join(root, ".oms", "taxonomy.json"), "utf8")).resolves.toBe(taxonomy);
    } finally {
      log.mockRestore();
      process.exitCode = undefined;
    }
  });

  it("blocks unresolved notes before composing a setup manifest and emits no digest", async () => {
    const root = await fresh();
    await authority(root);
    await mkdir(path.join(root, "Notes"), { recursive: true });
    await writeFile(path.join(root, "Notes", "broken.md"), "---\ntitle: [unterminated\n---\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runSetup({ vault: root, yes: true, dryRun: true, templateFolders: ["Templates"] });
      const output = log.mock.calls.map(call => call.join(" ")).join("\n");
      expect(output).toContain('"status": "blocked"');
      expect(output).toContain("MIGRATION_NOTE_INVALID");
      expect(output).not.toContain("inputDigest");
      expect(output).not.toContain("approvalDigest");
      expect(output).not.toContain("outputDigest");
      expect(existsSync(path.join(root, ".oms", "template-policy.json"))).toBe(false);
    } finally {
      log.mockRestore();
      process.exitCode = undefined;
    }
  });

  it("shows configured-folder candidates but does not select them non-interactively", async () => {
    const root = await fresh();
    await authority(root);
    await mkdir(path.join(root, "External", "Templater"), { recursive: true });
    await writeFile(path.join(root, "External", "Templater", "note.md"), "---\ntemplate: note\ntitle: Untitled\n---\nbody\n");
    await mkdir(path.join(root, ".obsidian", "plugins", "templater-obsidian"), { recursive: true });
    await writeFile(path.join(root, ".obsidian", "templates.json"), JSON.stringify({ folder: "External/Obsidian" }));
    await writeFile(path.join(root, ".obsidian", "plugins", "templater-obsidian", "data.json"), JSON.stringify({
      templates_folder: "External/Templater",
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runSetup({ vault: root, yes: true, dryRun: true })).resolves.toBe("blocked");
      const output = log.mock.calls.map(call => call.join(" ")).join("\n");
      expect(output).toContain("External/Obsidian");
      expect(output).toContain("External/Templater");
      expect(output).toContain("TEMPLATE_FOLDER_SELECTION_REQUIRED");
      expect(output).not.toContain("inputDigest");
      expect(output).not.toContain("approvalDigest");
      expect(output).not.toContain("outputDigest");
      expect(existsSync(path.join(root, ".oms", "template-policy.json"))).toBe(false);
    } finally {
      log.mockRestore();
      process.exitCode = undefined;
    }
  });

  it("lets an interactive prompt choose a configured hint as the creation default", async () => {
    const root = await fresh();
    await authority(root);
    await template(root, "External/Obsidian");
    await writeFile(path.join(root, ".obsidian", "templates.json"), JSON.stringify({
      folder: "External/Obsidian",
    }));
    const question = vi.fn(async () => "1");
    const close = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runSetup({
        vault: root,
        yes: true,
        dryRun: true,
        prompt: { question, close },
      })).resolves.toBe("completed");
      expect(question).toHaveBeenCalledWith(expect.stringContaining("first is creation default"));
      expect(close).toHaveBeenCalledOnce();
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("1. External/Obsidian");
      expect(output).toContain('"path": "External/Obsidian"');
      expect(output).toContain('"default": true');
      expect(output).toContain("approvalDigest");
    } finally {
      log.mockRestore();
    }
  });

  it("keeps setup blocked when an interactive candidate prompt is left blank", async () => {
    const root = await fresh();
    await authority(root);
    await writeFile(path.join(root, ".obsidian", "templates.json"), JSON.stringify({
      folder: "External/Obsidian",
    }));
    const close = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runSetup({
        vault: root,
        yes: true,
        dryRun: true,
        prompt: { question: async () => "", close },
      })).resolves.toBe("blocked");
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("1. External/Obsidian");
      expect(output).toContain("TEMPLATE_FOLDER_SELECTION_REQUIRED");
      expect(output).not.toContain("approvalDigest");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
      process.exitCode = undefined;
    }
  });

  it("blocks loudly without Obsidian type authority", async () => {
    const root = await fresh(); await template(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runSetup({
        vault: root,
        yes: true,
        dryRun: true,
        templateFolders: ["Templates"],
      })).resolves.toBe("blocked");
      expect(log.mock.calls.flat().join("\n")).toContain("MIGRATION_AUTHORITY_MISSING");
    } finally {
      log.mockRestore();
      process.exitCode = undefined;
    }
  });

  it("requires a shown digest and publishes through the guarded transaction", async () => {
    const root = await fresh(); await authority(root); await template(root);
    const digest = await approval(root);
    await expect(runSetup({ vault: root, yes: true, templateFolders: ["Templates"] })).rejects.toThrow("approvedDigest");
    let downloads = 0;
    await expect(runSetup({
      vault: root,
      yes: true,
      templateFolders: ["Templates"],
      approvedDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      modelSetManifest: modelManifest("0".repeat(64)),
      modelFetchImpl: async () => { downloads += 1; return new Response(); },
    })).rejects.toThrow("MIGRATION_APPROVAL_MISMATCH");
    expect(downloads).toBe(0);
    await runSetup({ vault: root, yes: true, templateFolders: ["Templates"], approvedDigest: digest });
    await expect(readFile(path.join(root, ".oms", "template-policy.json"), "utf8")).resolves.toContain("note");
    await expect(readFile(path.join(root, ".oms", "types.json"), "utf8")).resolves.toContain("oms.types.v1");
    await expect(readFile(path.join(root, ".oms", "template-migration.json"), "utf8")).resolves.toContain("complete");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runSetup({ vault: root, yes: true, dryRun: true })).resolves.toBe("completed");
      expect(log.mock.calls.flat().join("\n")).toContain('"templateFolderSource": "stored-v3"');
    } finally {
      log.mockRestore();
    }
  });

  it("acquires a complete capability set during approved setup and publishes portable selections", async () => {
    const root = await fresh(); await authority(root); await template(root);
    const cacheDir = await mkdtemp(path.join(tmpdir(), "oms-model-cache-"));
    const bytes = new TextEncoder().encode("model bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runSetup({
        vault: root,
        yes: true,
        templateFolders: ["Templates"],
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
    const root = await fresh(); await authority(root); await template(root);
    const cacheDir = path.join(root, "model-cache");
    let fetches = 0;
    await runSetup({
      vault: root,
      yes: true,
      dryRun: true,
      templateFolders: ["Templates"],
      modelCacheDir: cacheDir,
      modelSetManifest: modelManifest("a".repeat(64)),
      modelFetchImpl: async () => { fetches += 1; return new Response("unexpected"); },
    });
    expect(fetches).toBe(0);
    expect(existsSync(path.join(root, ".oms", "models.json"))).toBe(false);
    expect(existsSync(path.join(cacheDir, "installed-models.json"))).toBe(false);
  });

  it("preserves existing models configuration with the explicit no-default waiver", async () => {
    const root = await fresh(); await authority(root); await template(root);
    const existing = "{\"user\":\"owned\"}\n";
    await mkdir(path.join(root, ".oms"), { recursive: true });
    await writeFile(path.join(root, ".oms", "models.json"), existing, "utf8");
    await runSetup({ vault: root, yes: true, templateFolders: ["Templates"], approvedDigest: await approval(root), modelsNoDefault: true });
    await expect(readFile(path.join(root, ".oms", "models.json"), "utf8")).resolves.toBe(existing);
  });

  it("rejects malformed model manifests before setup writes files", async () => {
    const root = await fresh(); await authority(root); await template(root);
    await expect(runSetup({ vault: root, yes: true, templateFolders: ["Templates"], approvedDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000", modelSetManifest: "{not json" })).rejects.toThrow("Invalid installed-models.json: acquisition manifest is not valid JSON.");
    expect(existsSync(path.join(root, ".oms", "template-policy.json"))).toBe(false);
  });

  it("given a configured template folder, when setup runs, then discovery and policy use it", async () => {
    const root = await fresh();
    await authority(root);
    await writeFile(path.join(root, ".obsidian", "types.json"), JSON.stringify({ types: { template: "text", title: "text" } }));
    await mkdir(path.join(root, "Meta", "Templates"), { recursive: true });
    await writeFile(path.join(root, "Meta", "Templates", "custom.md"), "---\ntemplate: custom\ntitle: Untitled\n---\n# Custom\n", "utf8");
    await mkdir(path.join(root, ".oms"), { recursive: true });
    await writeFile(path.join(root, ".oms", "taxonomy.json"), JSON.stringify({
      folders: {},
      templates: { custom: { templateFolder: "Notes" } },
    }));
    const selected = [{ path: "Meta/Templates", mode: "auto" as const, default: true as const }];
    const state = await inspectSetup({ vault: root, templateFolders: selected });
    const manifest = await composeSetup(await decideNonInteractiveSetup(state), { base: { fields: {} } });

    await runSetup({ vault: root, yes: true, templateFolders: ["Meta/Templates"], approvedDigest: manifest.approvalDigest });
    const policy = JSON.parse(await readFile(path.join(root, ".oms", "template-policy.json"), "utf8")) as {
      templateFolders: readonly { path: string; mode: string; default?: boolean }[];
      templates: Record<string, { sourceFolder: string }>;
    };
    expect(policy.templateFolders).toEqual([{ path: "Meta/Templates", mode: "auto", default: true }]);
    expect(policy.templates.custom?.sourceFolder).toBe("Meta/Templates");
  });
});
