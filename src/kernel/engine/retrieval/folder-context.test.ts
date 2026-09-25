import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSettings } from "../../../../test/fixtures/contract-truth-table.js";
import { sealContract, storeRoot } from "../../contract/store.js";
import type { FolderContract } from "../../contract/types.js";
import { folderIntents, loadFolderIntentProjection, projectFolderIntents } from "./folder-context.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function emptyVault(): Promise<string> {
  const vault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-folder-context-")));
  tempDirs.push(vault);
  return vault;
}

async function sealedVault(folders: Record<string, FolderContract> | null): Promise<{ vault: string; vaultId: string }> {
  const vault = await emptyVault();
  const vaultId = randomUUID();
  await writeSettings(vault, vaultId);
  await sealContract({ vaultRealPath: vault, vaultId, contract: { folders, properties: null, templates: {} } });
  return { vault, vaultId };
}

describe("projectFolderIntents", () => {
  it("projects only matched top-level folders in deterministic order", () => {
    const projection = projectFolderIntents(new Map([
      ["zeta", "Zeta knowledge"], ["alpha", "Alpha knowledge"],
    ]), ["zeta/note.md", "root.md", "alpha/deeper/note.md"]);
    expect(projection.matched).toEqual([
      { folder: "alpha", intent: "Alpha knowledge", source: "folders.json" },
      { folder: "zeta", intent: "Zeta knowledge", source: "folders.json" },
    ]);
    expect(projection.promptContext).toBe("- alpha: Alpha knowledge\n- zeta: Zeta knowledge");
  });
  it("reports both directions of drift in stable code-point order", () => {
    const projection = projectFolderIntents(new Map([
      ["contract-only", "No files yet"], ["blank", "   "],
    ]), ["zulu/file.md", "alpha/file.md", "blank/file.md"]);
    expect(projection.indexedWithoutIntent).toEqual(["alpha", "blank", "zulu"]);
    expect(projection.foldersWithoutIndexed).toEqual(["contract-only"]);
    expect(projection.warnings).toEqual([
      'Indexed folder "alpha" has no meaning in the sealed folder contract.',
      'Indexed folder "blank" has no meaning in the sealed folder contract.',
      'Indexed folder "zulu" has no meaning in the sealed folder contract.',
      'Sealed folder "contract-only" has no indexed Markdown files.',
    ]);
  });
  it("scopes context to the selected collection folder", () => {
    const projection = projectFolderIntents(new Map([
      ["notes", "Permanent notes"], ["references", "External references"],
    ]), ["notes/a.md", "references/b.md"], "notes/deeper");
    expect(projection.matched).toEqual([{ folder: "notes", intent: "Permanent notes", source: "folders.json" }]);
    expect(projection.warnings).toEqual([]);
    expect(projection.promptContext).toBe("- notes: Permanent notes");
  });
  it("ignores root notes and hidden state because neither has a folder intent", () => {
    const projection = projectFolderIntents(new Map([["notes", "Notes"]]), ["root.md", ".gjc/session/plan.md", "notes/real.md"]);
    expect(projection.matched.map(({ folder }) => folder)).toEqual(["notes"]);
    expect(projection.warnings).toEqual([]);
  });
  it("keeps only top-level sealed folders with a meaning", () => {
    expect([...folderIntents({
      notes: { meaning: " Notes ", searchExclude: false },
      "notes/deep": { meaning: "Nested", searchExclude: false },
      empty: { meaning: "  ", searchExclude: false },
    })]).toEqual([["notes", "Notes"]]);
    expect(folderIntents(null).size).toBe(0);
  });
});

describe("loadFolderIntentProjection", () => {
  it("reads folder meaning from the sealed folders.json without writing the vault", async () => {
    const { vault } = await sealedVault({
      references: { meaning: "Processed sources.", searchExclude: false },
      notes: { meaning: "Permanent notes.", searchExclude: true },
    });
    const projection = await loadFolderIntentProjection(vault, ["references/a.md", "notes/b.md"]);
    expect(projection.matched).toEqual([
      { folder: "notes", intent: "Permanent notes.", source: "folders.json" },
      { folder: "references", intent: "Processed sources.", source: "folders.json" },
    ]);
    expect((await readdir(path.join(vault, ".oms"))).sort()).toEqual(["settings.json"]);
  });
  it("does not invent meaning when the folder axis is open", async () => {
    const { vault } = await sealedVault(null);
    const projection = await loadFolderIntentProjection(vault, ["notes/a.md"]);
    expect(projection.matched).toEqual([]);
    expect(projection.promptContext).toBeUndefined();
  });
  it("keeps an unsealed vault free of OMS state", async () => {
    const vault = await emptyVault();
    await expect(loadFolderIntentProjection(vault, ["notes/a.md"])).resolves.toMatchObject({ matched: [], indexedWithoutIntent: ["notes"] });
    expect(existsSync(path.join(vault, ".oms"))).toBe(false);
  });
  it("treats a missing vault as unsealed", async () => {
    const vault = path.join(await emptyVault(), "missing");
    await expect(loadFolderIntentProjection(vault, ["notes/a.md"])).resolves.toMatchObject({ matched: [] });
  });
  it.each([["models", "json"].join("."), `${["tax", "onomy"].join("")}.json`, `${["template", "policy"].join("-")}.json`, `${["contract", "public"].join("-")}.json`])(
    "never reads a retired vault-local %s", async file => {
      const vault = await emptyVault();
      await writeSettings(vault, randomUUID());
      await writeFile(path.join(vault, ".oms", file), JSON.stringify({ folders: { notes: { intent: "Leaked." } } }));
      await expect(loadFolderIntentProjection(vault, ["notes/a.md"])).resolves.toMatchObject({ matched: [] });
    });
  it("reports an unreadable seal rather than guessing context", async () => {
    const { vault, vaultId } = await sealedVault({ notes: { meaning: "Permanent notes.", searchExclude: false } });
    const generation = (await readdir(storeRoot())).find(entry => entry.startsWith(`.${vaultId}.`))!;
    await writeFile(path.join(storeRoot(), generation, "folders.json"), "{\"version\":1,\"folders\":{}}\n");
    await expect(loadFolderIntentProjection(vault, ["notes/a.md"])).rejects.toThrow("FOLDER_CONTEXT_INVALID");
  });
});
