import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sealContract, storeRoot } from "../../contract/store.js";
import type { PropertyContract, VaultContract } from "../../contract/types.js";
import { serializeVaultSettings } from "../../vault/settings.js";
import { readSearchTemplateSource } from "./template-source.js";

const SECRET = "SECRET-RULE-VALUE-42";
const SOURCE_HASH = `sha256:${"0".repeat(64)}` as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function makeVault(files: Record<string, string> = {}): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "oms-search-source-")));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  return root;
}

function property(overrides: Partial<PropertyContract> = {}): PropertyContract {
  return { meaning: "a property", type: "text", default: false, required: false, rules: [], ...overrides };
}

function contract(): VaultContract {
  return {
    folders: {
      Notes: { meaning: "Working notes.", searchExclude: false },
      Drafts: { meaning: "Unfinished drafts.", searchExclude: true },
    },
    properties: {
      title: property({ required: true }),
      status: property({ rules: [{ kind: "allowed", values: [SECRET, "done"] }] }),
      tags: property({ type: "tags", rules: [{ kind: "fixed", value: SECRET }] }),
    },
    templates: {
      zeta: { source: "Sources/z.md", sourceHash: SOURCE_HASH, requiredProperties: ["status"], narrowedRules: { status: [{ kind: "fixed", value: SECRET }] }, requiredHeadings: [] },
      alpha: { source: "Sources/a.md", sourceHash: SOURCE_HASH, applyFolder: "Notes", requiredProperties: [], narrowedRules: {}, requiredHeadings: ["Summary"] },
    },
  };
}

async function seal(vault: string, sealed: VaultContract): Promise<string> {
  const vaultId = randomUUID();
  await mkdir(path.join(vault, ".oms"), { recursive: true });
  await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId }));
  await sealContract({ vaultRealPath: vault, vaultId, contract: sealed });
  return vaultId;
}

const SOURCES = { "Sources/a.md": "# alpha\n", "Sources/z.md": "# zeta\n" };

describe("readSearchTemplateSource", () => {
  it("projects the sealed acceptance surface into retrieval fields and the folder axis", async () => {
    const vault = await makeVault(SOURCES);
    await seal(vault, contract());
    const read = await readSearchTemplateSource(vault);
    expect(read.source.generationDigest).toBe(read.digest);
    expect(read.source.defaultFields).toEqual({
      status: { property: "status", type: "text", required: false, valuePolicy: "free" },
      tags: { property: "tags", type: "tags", required: false, valuePolicy: "free" },
      title: { property: "title", type: "text", required: true, valuePolicy: "free" },
    });
    expect(Object.keys(read.source.templates ?? {}).sort()).toEqual(["alpha", "zeta"]);
    // A template's required properties are required in its own field set only.
    expect(read.source.templates?.["zeta"]?.["status"]?.required).toBe(true);
    expect(read.source.templates?.["alpha"]?.["status"]?.required).toBe(false);
    expect(read.source.globalAxes?.["folder-ontology"]).toMatchObject({
      kind: "folder",
      members: ["Drafts", "Notes"],
      extensions: { intents: { Drafts: "Unfinished drafts.", Notes: "Working notes." } },
    });
    expect(read.source.sourcePaths).toEqual(["Sources/a.md", "Sources/z.md"]);
    expect(read.diagnostics).toEqual([]);
    expect(Object.keys(read.source).sort()).toEqual(["defaultFields", "generationDigest", "globalAxes", "sourcePaths", "templates"]);
  });

  it("never exposes a rule value or narrowed rule", async () => {
    const vault = await makeVault(SOURCES);
    await seal(vault, contract());
    const read = await readSearchTemplateSource(vault);
    expect(JSON.stringify(read)).not.toContain(SECRET);
  });

  it("keeps the digest independent of rule values", async () => {
    const first = await makeVault(SOURCES);
    await seal(first, contract());
    const second = await makeVault(SOURCES);
    const changed = contract();
    await seal(second, { ...changed, properties: { ...changed.properties, status: property({ rules: [{ kind: "allowed", values: ["other"] }] }) } });
    expect((await readSearchTemplateSource(second)).source.defaultFields)
      .toEqual((await readSearchTemplateSource(first)).source.defaultFields);
  });

  it("reports an open vault without inventing a contract or creating .oms", async () => {
    const vault = await makeVault();
    const read = await readSearchTemplateSource(vault);
    expect(read.source).toMatchObject({ defaultFields: null, templates: null, sourcePaths: null });
    expect(read.source.globalAxes).toEqual({});
    expect(read.diagnostics.map(item => item.code)).toEqual(["CONTRACT_OPEN"]);
    expect(read.diagnostics[0]?.message).toContain("contract: none");
    expect(read.diagnostics[0]?.message).toContain("run oms setup");
    expect(existsSync(path.join(vault, ".oms"))).toBe(false);
  });

  it("reports a missing vault as open", async () => {
    const vault = path.join(await makeVault(), "missing");
    const read = await readSearchTemplateSource(vault);
    expect(read.diagnostics.map(item => item.code)).toContain("CONTRACT_OPEN");
    const open = read.diagnostics.find(item => item.code === "CONTRACT_OPEN");
    expect(open?.message).toContain("vault not found");
    expect(open?.message).not.toContain("oms setup");
  });

  it("points unreadable vault settings at doctor, as oms contract doctor does", async () => {
    const vault = await makeVault();
    await mkdir(path.join(vault, ".oms"), { recursive: true });
    await writeFile(path.join(vault, ".oms", "settings.json"), "{not json\n");
    const read = await readSearchTemplateSource(vault);
    const open = read.diagnostics.find(item => item.code === "CONTRACT_OPEN");
    expect(open?.message).toContain("vault settings unreadable");
    expect(open?.message).toContain("run oms contract doctor");
  });

  it("reports an unreadable seal as unavailable metadata instead of throwing", async () => {
    const vault = await makeVault(SOURCES);
    const vaultId = await seal(vault, contract());
    const sealed = await readSearchTemplateSource(vault);
    const generation = (await readdir(storeRoot())).find(entry => entry.startsWith(`.${vaultId}.`))!;
    await writeFile(path.join(storeRoot(), generation, "folders.json"), "{\"version\":1,\"folders\":{}}\n");
    const read = await readSearchTemplateSource(vault);
    expect(read.source).toMatchObject({ defaultFields: null, templates: null, globalAxes: null, sourcePaths: null });
    expect(read.diagnostics.map(item => item.code)).toContain("CONTRACT_UNREADABLE");
    expect(read.digest).not.toBe(sealed.digest);
  });

  it("names a failed contract read by code, never by the store path", async () => {
    const vault = await makeVault(SOURCES);
    await seal(vault, contract());
    await chmod(storeRoot(), 0o000);
    try {
      const read = await readSearchTemplateSource(vault);
      const unreadable = read.diagnostics.find(item => item.code === "CONTRACT_UNREADABLE");
      expect(unreadable?.message).toMatch(/^sealed contract is unavailable: [A-Z][A-Z0-9_]*; run oms contract doctor$/);
      expect(JSON.stringify(read)).not.toContain(storeRoot());
    } finally {
      await chmod(storeRoot(), 0o700);
    }
  });

  it("keeps null contract axes unavailable while other axes stay in force", async () => {
    const vault = await makeVault(SOURCES);
    await seal(vault, { ...contract(), properties: null });
    const read = await readSearchTemplateSource(vault);
    expect(read.source.defaultFields).toBeNull();
    expect(read.source.templates).toEqual({ alpha: null, zeta: null });
    expect(read.source.globalAxes?.["folder-ontology"]).toBeDefined();
  });

  it("carries the source exclusion inventory and changes digest with it", async () => {
    const vault = await makeVault(SOURCES);
    await seal(vault, contract());
    const first = await readSearchTemplateSource(vault);
    expect(first.exclusions.paths).toEqual(["Sources/a.md", "Sources/z.md"]);
    expect(first.exclusions.globs).toEqual(expect.arrayContaining(["Drafts", "Drafts/**"]));

    const other = await makeVault(SOURCES);
    await seal(other, { ...contract(), folders: { ...contract().folders, Drafts: { meaning: "Unfinished drafts.", searchExclude: false } } });
    const second = await readSearchTemplateSource(other);
    expect(second.exclusions.globs).not.toContain("Drafts/**");
    expect(second.digest).not.toBe(first.digest);
  });

  it("ignores retired vault control files", async () => {
    const vault = await makeVault({
      ...SOURCES,
      [`.oms/${["template", "policy"].join("-")}.json`]: "{broken",
      [`.oms/${["tax", "onomy"].join("")}.json`]: "{broken",
    });
    const before = await readSearchTemplateSource(vault);
    expect(before.diagnostics.map(item => item.code)).toEqual(["CONTRACT_OPEN"]);
    await rm(path.join(vault, ".oms"), { recursive: true });
    const after = await readSearchTemplateSource(vault);
    expect(after.digest).toBe(before.digest);
  });
});
