import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { sealContract, storeRoot } from "../contract/store.js";
import type { FolderContract, TemplateContract } from "../contract/types.js";
import { serializeVaultSettings } from "../vault/settings.js";
import {
  DEFAULT_EXCLUDE_GLOBS,
  excludedNoteMatcher,
  managedSourceExclusionMatcher,
  managedSourcePathSet,
  matchesAnyGlob,
  readSourceExclusions,
} from "./note-exclude.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }));
});

async function makeVault(files: Record<string, string> = {}): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), "oms-note-exclude-"));
  const vault = await realpath(created);
  roots.push(vault);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(vault, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return vault;
}

const SOURCE_HASH = `sha256:${"0".repeat(64)}`;

function template(source: string): TemplateContract {
  return { source, sourceHash: SOURCE_HASH, requiredProperties: [], narrowedRules: {}, requiredHeadings: [] };
}

interface SealOptions {
  readonly templateFolder?: string;
  readonly folders?: Readonly<Record<string, FolderContract>> | null;
  readonly sources?: readonly string[];
}

/** Seals a contract into the per-test temporary store and writes vault settings. */
async function seal(vault: string, options: SealOptions = {}): Promise<string> {
  const vaultId = randomUUID();
  await mkdir(path.join(vault, ".oms"), { recursive: true });
  await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings({
    version: 1,
    vaultId,
    ...(options.templateFolder === undefined ? {} : { templateFolder: options.templateFolder }),
  }));
  const templates = Object.fromEntries((options.sources ?? []).map((source, index) => [`t${index}`, template(source)]));
  await sealContract({ vaultRealPath: vault, vaultId, contract: { folders: options.folders ?? null, properties: null, templates } });
  return vaultId;
}

async function writeSettingsFile(vault: string, templateFolder?: string): Promise<void> {
  await mkdir(path.join(vault, ".oms"), { recursive: true });
  await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings({
    version: 1,
    vaultId: randomUUID(),
    ...(templateFolder === undefined ? {} : { templateFolder }),
  }));
}

async function tamper(vaultId: string): Promise<void> {
  const generation = (await readdir(storeRoot())).find(entry => entry.startsWith(`.${vaultId}.`))!;
  await writeFile(path.join(storeRoot(), generation, "folders.json"), "{\"version\":1,\"folders\":{}}\n");
}

function excluded(meaning = "excluded"): FolderContract {
  return { meaning, searchExclude: true };
}

describe("matchesAnyGlob", () => {
  it("`**` crosses a `/` boundary", () => {
    expect(matchesAnyGlob("a/b/c.template.md", ["**/*.template.md"])).toBe(true);
    expect(matchesAnyGlob("references/skip.template.md", ["**/*.template.md"])).toBe(true);
  });

  it("plain `*` does not cross a `/` boundary", () => {
    expect(matchesAnyGlob("notes/skip.md", ["*.md"])).toBe(false);
    expect(matchesAnyGlob("skip.md", ["*.md"])).toBe(true);
  });

  it("regression: the globstar placeholder must survive the escaping step", () => {
    expect(matchesAnyGlob("25. Digital Garden/.deploy-staging/draft.md", DEFAULT_EXCLUDE_GLOBS)).toBe(true);
    expect(matchesAnyGlob("templates/daily/entry.template.md", ["**/*.template.md"])).toBe(true);
    expect(matchesAnyGlob("a/b/c/d/SKILL.md", ["**/SKILL.md"])).toBe(true);
  });

  it("returns false when no glob matches", () => {
    expect(matchesAnyGlob("references/clean-architecture.md", DEFAULT_EXCLUDE_GLOBS)).toBe(false);
  });
});

describe("readSourceExclusions", () => {
  it("keeps settings roots, sealed template sources and searchExclude folders", async () => {
    const vault = await makeVault({
      "Templates/flower.md": "raw source",
      "notes/idea.md": "ordinary",
    });
    await seal(vault, {
      templateFolder: "Shared Templates",
      folders: { drafts: excluded(), notes: { meaning: "notes", searchExclude: false } },
      sources: ["Templates/flower.md"],
    });
    const inventory = await readSourceExclusions(vault);
    expect(inventory.roots).toEqual(["Shared Templates"]);
    expect(inventory.paths).toEqual(["Templates/flower.md"]);
    expect(inventory.globs).toEqual([...DEFAULT_EXCLUDE_GLOBS, "drafts", "drafts/**"]);
    expect(inventory.complete).toBe(true);
    expect(inventory.diagnostics).toEqual([]);
    expect(await managedSourcePathSet(vault)).toEqual(new Set(["Templates/flower.md"]));
    const lexical = await excludedNoteMatcher(vault);
    expect(lexical("Templates/flower.md")).toBe(true);
    expect(lexical("notes/idea.md")).toBe(false);
    expect(lexical("drafts/unfinished.md")).toBe(true);
    expect(lexical("drafts/deep/unfinished.md")).toBe(true);
    expect(lexical("draftsX/note.md")).toBe(false);
    expect(lexical("Templates/unregistered.md")).toBe(false);
    expect(lexical("Shared Templates/discovered.md")).toBe(true);
    expect(lexical("Templates.md")).toBe(false);
  });

  it("does not invent a physical default or roots from folder names", async () => {
    const vault = await makeVault({
      "Templates/flower.md": "sealed source",
      "Prompts/template.md": "<% tp.file.title %>",
      "Prompts/ordinary.md": "ordinary",
    });
    await seal(vault, { sources: ["Templates/flower.md"] });
    const inventory = await readSourceExclusions(vault);
    expect(inventory.roots).toEqual([]);
    expect(inventory.paths).toEqual(["Templates/flower.md"]);
    expect(inventory.complete).toBe(true);
    const lexical = await excludedNoteMatcher(vault, false);
    expect(lexical("Prompts/template.md")).toBe(false);
    expect(lexical("Prompts/ordinary.md")).toBe(false);
    expect(lexical("Templates/flower.md")).toBe(false);
  });

  it("ignores retired vault control files (AC4)", async () => {
    const vault = await makeVault({
      [`.oms/${["template", "policy"].join("-")}.json`]: JSON.stringify({ version: 5, templates: { flower: { source: { path: "Templates/flower.md" } } } }),
      [`.oms/${["tax", "onomy"].join("")}.json`]: JSON.stringify({ exclude: ["drafts/**"] }),
      [`.oms/${["models", "json"].join(".")}`]: "{broken",
      "Templates/flower.md": "source",
      "drafts/unfinished.md": "draft",
    });
    const inventory = await readSourceExclusions(vault);
    expect(inventory).toMatchObject({ roots: [], paths: [], globs: [...DEFAULT_EXCLUDE_GLOBS], complete: true, diagnostics: [] });
    const lexical = await excludedNoteMatcher(vault);
    expect(lexical("Templates/flower.md")).toBe(false);
    expect(lexical("drafts/unfinished.md")).toBe(false);
  });

  it("preserves valid settings roots when the seal is unreadable and blocks lexical matching", async () => {
    const vault = await makeVault({ "notes/idea.md": "ordinary" });
    const vaultId = await seal(vault, { templateFolder: "Templates", folders: { drafts: excluded() }, sources: ["Templates/flower.md"] });
    await tamper(vaultId);
    const inventory = await readSourceExclusions(vault);
    expect(inventory.roots).toEqual(["Templates"]);
    expect(inventory.paths).toEqual([]);
    expect(inventory.globs).toEqual([...DEFAULT_EXCLUDE_GLOBS]);
    expect(inventory.complete).toBe(false);
    expect(inventory.diagnostics).toEqual([expect.objectContaining({ code: "SOURCE_CONTRACT_UNREADABLE", path: "folders.json" })]);
    await expect(excludedNoteMatcher(vault)).rejects.toThrow(/NOTE_EXCLUSION_RESOLUTION_FAILED: folders\.json/);
    await expect(managedSourceExclusionMatcher(vault)).rejects.toThrow(/NOTE_EXCLUSION_RESOLUTION_FAILED: folders\.json/);
  });

  it("fails closed when settings name an unsafe root because the seal cannot be resolved", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "oms-note-exclude-outside-"));
    roots.push(await realpath(outside));
    const vault = await makeVault({ "drafts/unfinished.md": "draft" });
    await seal(vault, { folders: { drafts: excluded() } });
    const settingsPath = path.join(vault, ".oms", "settings.json");
    const current = JSON.parse(await readFile(settingsPath, "utf8")) as { vaultId: string };
    await writeFile(settingsPath, JSON.stringify({ version: 1, vaultId: current.vaultId, templateFolder: "../outside" }));
    const inventory = await readSourceExclusions(vault);
    expect(inventory.roots).toEqual([]);
    expect(inventory.complete).toBe(false);
    expect(inventory.diagnostics.map(item => item.path)).toContain(".oms/settings.json");
    expect(inventory.diagnostics.map(item => item.code)).toContain("SOURCE_CONTRACT_UNREADABLE");
    await expect(excludedNoteMatcher(vault)).rejects.toThrow(/NOTE_EXCLUSION_RESOLUTION_FAILED: folders\.json/);
  });

  it("classifies a hardlinked sealed source without dropping its lexical exclusion", async () => {
    const vault = await makeVault({
      "authored/original.md": "original",
      "notes/idea.md": "ordinary",
    });
    await link(path.join(vault, "authored", "original.md"), path.join(vault, "authored", "hard.md"));
    await seal(vault, { sources: ["authored/hard.md"] });
    const inventory = await readSourceExclusions(vault);
    expect(inventory.paths).toEqual(["authored/hard.md"]);
    expect(inventory.complete).toBe(false);
    expect(inventory.diagnostics).toEqual([expect.objectContaining({ code: "SOURCE_ALIAS_UNSAFE" })]);
    expect((await excludedNoteMatcher(vault))("authored/hard.md")).toBe(true);
    expect((await excludedNoteMatcher(vault))("notes/idea.md")).toBe(false);
    const isExcluded = await managedSourceExclusionMatcher(vault, ["authored/hard.md"]);
    await expect(isExcluded("authored/hard.md")).resolves.toBe(true);
    await expect(isExcluded("authored/original.md")).resolves.toBe(false);
    await expect(isExcluded("notes/idea.md")).resolves.toBe(false);
  });

  it("excludes a missing sealed source lexically and a confined alias deliberately", async () => {
    const vault = await makeVault({ "authored/नोट 이름.md": "---\ntitle: template\n---\n" });
    await mkdir(path.join(vault, "aliases"));
    await symlink(path.join(vault, "authored", "नोट 이름.md"), path.join(vault, "aliases", "copy.md"));
    await seal(vault, { sources: ["Templates/missing.md"] });
    const inventory = await readSourceExclusions(vault);
    expect(inventory.paths).toEqual(["Templates/missing.md"]);
    const isExcluded = await managedSourceExclusionMatcher(vault, ["authored/नोट 이름.md"]);
    await expect(isExcluded("authored/नोट 이름.md")).resolves.toBe(true);
    await expect(isExcluded("aliases/copy.md")).resolves.toBe(true);
    await expect(isExcluded("Templates/missing.md")).resolves.toBe(true);
    await expect(isExcluded("notes/idea.md")).resolves.toBe(false);
  });

  it("observes a settings edit in the same process and creates no cache", async () => {
    const vault = await makeVault();
    await writeSettingsFile(vault, "Templates");
    const before = await readSourceExclusions(vault);
    expect(before.roots).toEqual(["Templates"]);
    await writeSettingsFile(vault, "Library");
    const after = await readSourceExclusions(vault);
    expect(after.roots).toEqual(["Library"]);
    expect(after.digest).not.toBe(before.digest);
    expect((await lstat(path.join(vault, ".oms"))).isDirectory()).toBe(true);
    await expect(lstat(path.join(vault, ".oms", "index"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(vault, ".oms", "cache"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("excludes a settings root before the edit and the replacement root after it", async () => {
    const vault = await makeVault({
      "Templates/discovered.md": "unregistered",
      "Library/discovered.md": "later root",
      "notes/idea.md": "ordinary",
    });
    await writeSettingsFile(vault, "Templates");
    const before = await excludedNoteMatcher(vault);
    expect(before("Templates/discovered.md")).toBe(true);
    expect(before("Library/discovered.md")).toBe(false);
    await writeSettingsFile(vault, "Library");
    const after = await excludedNoteMatcher(vault);
    expect(after("Templates/discovered.md")).toBe(false);
    expect(after("Library/discovered.md")).toBe(true);
    const supplied = await managedSourceExclusionMatcher(vault, []);
    await expect(supplied("Library/discovered.md")).resolves.toBe(true);
    await expect(supplied("notes/idea.md")).resolves.toBe(false);
  });

  it("does not create OMS state while reading an empty vault", async () => {
    const vault = await makeVault();
    const inventory = await readSourceExclusions(vault);
    expect(inventory).toMatchObject({ roots: [], paths: [], globs: [...DEFAULT_EXCLUDE_GLOBS], complete: true, diagnostics: [] });
    await expect(lstat(path.join(vault, ".oms"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await excludedNoteMatcher(vault))("notes/idea.md")).toBe(false);
  });

  it("changes digest for open, invalid settings, and different sealed exclusions", async () => {
    const open = await readSourceExclusions(await makeVault());
    const invalidVault = await makeVault({ ".oms/settings.json": "{" });
    const invalid = await readSourceExclusions(invalidVault);
    const first = await makeVault();
    await seal(first, { folders: { a: excluded() } });
    const second = await makeVault();
    await seal(second, { folders: { b: excluded() } });
    const sealedA = await readSourceExclusions(first);
    const sealedB = await readSourceExclusions(second);
    expect(new Set([open.digest, invalid.digest, sealedA.digest, sealedB.digest]).size).toBe(4);
    expect(sealedA.complete).toBe(true);
    expect(invalid.complete).toBe(false);
  });
});

describe("excludedNoteMatcher", () => {
  it("applies only the built-in defaults when no sealed folder is excluded", async () => {
    const vault = await makeVault();
    await seal(vault, { folders: { notes: { meaning: "notes", searchExclude: false } } });
    const isExcluded = await excludedNoteMatcher(vault);
    expect(isExcluded(".obsidian/workspace.md")).toBe(true);
    expect(isExcluded("notes/idea.md")).toBe(false);
  });

  it("does not retarget a noncanonical sealed source", async () => {
    const nfc = "é".normalize("NFC");
    const nfd = "é".normalize("NFD");
    const vault = await makeVault({
      [`Sources/${nfc}.md`]: "composed source",
      [`${nfc}/note.md`]: "composed note",
    });
    await seal(vault, { sources: [`Sources/${nfd}.md`, "../private.md"] });
    const inventory = await readSourceExclusions(vault);
    expect(inventory.paths).toEqual([]);
    expect(inventory.complete).toBe(false);
    expect(inventory.diagnostics.map(item => item.code)).toEqual(["SOURCE_REGISTRATION_NONCANONICAL", "SOURCE_REGISTRATION_NONCANONICAL"]);
    const lexical = await excludedNoteMatcher(vault);
    expect(lexical(`Sources/${nfc}.md`)).toBe(false);
    expect(lexical(`Sources/${nfd}.md`)).toBe(false);
    expect(lexical(`${nfc}/note.md`)).toBe(false);
  });

  it("excludes confined file and directory aliases without following an outside target", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "oms-note-exclude-alias-"));
    roots.push(await realpath(outside));
    await writeFile(path.join(outside, "private.md"), "private");
    const vault = await makeVault({
      "authored/original.md": "original",
      "nested/original.md": "directory target",
      "notes/idea.md": "ordinary",
    });
    await mkdir(path.join(vault, "aliases"));
    await symlink(path.join(vault, "authored", "original.md"), path.join(vault, "aliases", "file.md"));
    await symlink(path.join(vault, "nested"), path.join(vault, "aliases", "directory"));
    await symlink(path.join(outside, "private.md"), path.join(vault, "aliases", "outside.md"));
    const isExcluded = await managedSourceExclusionMatcher(vault, ["authored/original.md", "nested/original.md"]);
    await expect(isExcluded("aliases/file.md")).resolves.toBe(true);
    await expect(isExcluded("aliases/directory/original.md")).resolves.toBe(true);
    await expect(isExcluded("aliases/outside.md")).resolves.toBe(false);
    await expect(isExcluded("notes/idea.md")).resolves.toBe(false);
  });

  it("keeps a lexically safe sealed source excluded when its file is missing, linked, hardlinked, or not a file", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "oms-note-exclude-source-"));
    roots.push(await realpath(outside));
    await writeFile(path.join(outside, "private.md"), "private");
    const vault = await makeVault({
      "authored/original.md": "original",
      "notes/ordinary-hardlink.md": "ordinary hardlink",
      "notes/idea.md": "ordinary",
    });
    await mkdir(path.join(vault, "Sources"));
    await symlink(path.join(outside, "private.md"), path.join(vault, "Sources", "linked.md"));
    await link(path.join(vault, "authored", "original.md"), path.join(vault, "Sources", "hard.md"));
    await link(path.join(vault, "notes", "ordinary-hardlink.md"), path.join(vault, "notes", "second-hardlink.md"));
    await mkdir(path.join(vault, "Sources", "folder.md"));
    await seal(vault, { sources: ["Sources/missing.md", "Sources/linked.md", "Sources/hard.md", "Sources/folder.md"] });
    const inventory = await readSourceExclusions(vault);
    expect(inventory.paths).toEqual(["Sources/folder.md", "Sources/hard.md", "Sources/linked.md", "Sources/missing.md"]);
    expect(inventory.complete).toBe(false);
    const lexical = await excludedNoteMatcher(vault);
    expect(lexical("Sources/missing.md")).toBe(true);
    expect(lexical("Sources/linked.md")).toBe(true);
    expect(lexical("Sources/hard.md")).toBe(true);
    expect(lexical("Sources/folder.md")).toBe(true);
    expect(lexical("notes/idea.md")).toBe(false);
    const isExcluded = await managedSourceExclusionMatcher(vault);
    await expect(isExcluded("Sources/linked.md")).resolves.toBe(true);
    await expect(isExcluded("notes/ordinary-hardlink.md")).resolves.toBe(false);
    await expect(isExcluded("notes/second-hardlink.md")).resolves.toBe(false);
    await expect(isExcluded("notes/idea.md")).resolves.toBe(false);
  });
});
