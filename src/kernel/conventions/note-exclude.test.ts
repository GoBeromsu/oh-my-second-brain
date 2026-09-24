import { describe, it, expect, afterEach } from "vitest";
import { chmod, link, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { digestBytes } from "../templates/canonical.js";
import { serializeContractPolicyV5 } from "../templates/contract-v5.js";
import type { ContractPolicyV5 } from "../templates/contract-v5.js";
import { serializeVaultSettings } from "../templates/vault-settings.js";
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

const VAULT_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_DIGEST = digestBytes("source bytes");

function settings(templateRoots: readonly string[] = ["Templates"]): string {
  return serializeVaultSettings({ version: 1, vaultId: VAULT_ID, templateRoots });
}

function policy(sourcePath = "Templates/flower.md"): string {
  const document: ContractPolicyV5 = {
    version: 5,
    revision: 1,
    properties: { title: { type: "text" } },
    common: { status: "active", fields: {} },
    templates: {
      flower: {
        status: "active",
        source: { identity: "source-flower", path: sourcePath, rawDigest: SOURCE_DIGEST },
        fields: {},
      },
    },
  };
  return serializeContractPolicyV5(document);
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
  it("keeps validated settings roots and original V5 source registrations", async () => {
    const vault = await makeVault({
      ".oms/settings.json": settings(["Templates", "Shared Templates"]),
      ".oms/template-policy.json": policy(),
      ".oms/taxonomy.json": JSON.stringify({ folders: {}, exclude: ["drafts/**"] }),
      "Templates/flower.md": "raw source",
      "notes/idea.md": "ordinary",
    });
    const inventory = await readSourceExclusions(vault);
    expect(inventory.roots).toEqual(["Templates", "Shared Templates"]);
    expect(inventory.paths).toEqual(["Templates/flower.md"]);
    expect(inventory.globs).toEqual([...DEFAULT_EXCLUDE_GLOBS, "drafts/**"]);
    expect(inventory.complete).toBe(true);
    expect(inventory.diagnostics).toEqual([]);
    expect(await managedSourcePathSet(vault)).toEqual(new Set(["Templates/flower.md"]));
    const lexical = await excludedNoteMatcher(vault);
    expect(lexical("Templates/flower.md")).toBe(true);
    expect(lexical("notes/idea.md")).toBe(false);
    expect(lexical("drafts/unfinished.md")).toBe(true);
    expect(lexical("Templates/unregistered.md")).toBe(true);
    expect(lexical("Shared Templates/discovered.md")).toBe(true);
    expect(lexical("Templates.md")).toBe(false);
  });

  it("does not invent a physical default or roots from folder names", async () => {
    const vault = await makeVault({
      ".oms/template-policy.json": policy(),
      "Templates/flower.md": "common-only source",
      "Prompts/template.md": "<% tp.file.title %>",
      "Prompts/ordinary.md": "ordinary",
    });
    const inventory = await readSourceExclusions(vault);
    expect(inventory.roots).toEqual([]);
    expect(inventory.paths).toEqual(["Templates/flower.md"]);
    expect(inventory.complete).toBe(true);
    const lexical = await excludedNoteMatcher(vault, false);
    expect(lexical("Prompts/template.md")).toBe(false);
    expect(lexical("Prompts/ordinary.md")).toBe(false);
    expect(lexical("Templates/flower.md")).toBe(false);
  });

  it("preserves valid settings roots when policy is invalid", async () => {
    const vault = await makeVault({
      ".oms/settings.json": settings(),
      ".oms/template-policy.json": "{broken",
      "notes/idea.md": "ordinary",
    });
    const inventory = await readSourceExclusions(vault);
    expect(inventory.roots).toEqual(["Templates"]);
    expect(inventory.paths).toEqual([]);
    expect(inventory.complete).toBe(false);
    expect(inventory.diagnostics.map(item => item.path)).toContain(".oms/template-policy.json");
    expect(inventory.diagnostics.some(item => /additional sources may/i.test(item.message))).toBe(false);
    const lexical = await excludedNoteMatcher(vault);
    expect(lexical("notes/idea.md")).toBe(false);
    expect(lexical("Templates/unregistered.md")).toBe(true);
  });

  it("preserves an explicit source registration when taxonomy is invalid", async () => {
    const vault = await makeVault({
      ".oms/template-policy.json": policy(),
      ".oms/taxonomy.json": JSON.stringify({ exclude: { drafts: true } }),
      "Templates/flower.md": "source",
      "notes/idea.md": "ordinary",
    });
    const inventory = await readSourceExclusions(vault);
    expect(inventory.paths).toEqual(["Templates/flower.md"]);
    expect(inventory.globs).toEqual([...DEFAULT_EXCLUDE_GLOBS]);
    expect(inventory.complete).toBe(false);
    expect(inventory.diagnostics).toEqual([expect.objectContaining({ code: "SOURCE_TAXONOMY_INVALID", path: ".oms/taxonomy.json" })]);
    await expect(excludedNoteMatcher(vault)).rejects.toThrow(/NOTE_EXCLUSION_RESOLUTION_FAILED: \.oms\/taxonomy\.json/);
  });

  it("keeps valid taxonomy exclusions when policy is unreadable", async () => {
    const vault = await makeVault({
      ".oms/taxonomy.json": JSON.stringify({ exclude: ["drafts/**"] }),
      ".oms/template-policy.json": policy(),
    });
    await chmod(path.join(vault, ".oms", "template-policy.json"), 0);
    const inventory = await readSourceExclusions(vault);
    expect(inventory.globs).toEqual([...DEFAULT_EXCLUDE_GLOBS, "drafts/**"]);
    expect(inventory.paths).toEqual([]);
    expect(inventory.complete).toBe(false);
    expect(inventory.diagnostics).toEqual([expect.objectContaining({ code: "SOURCE_CONTROL_UNREADABLE", path: ".oms/template-policy.json" })]);
    expect((await excludedNoteMatcher(vault))("drafts/unfinished.md")).toBe(true);
  });

  it("warns that additional sources may appear when both policy and taxonomy are unusable", async () => {
    const vault = await makeVault({
      ".oms/settings.json": settings(),
      ".oms/template-policy.json": "not-json",
      ".oms/taxonomy.json": "not-json",
      "notes/idea.md": "ordinary",
    });
    const inventory = await readSourceExclusions(vault);
    expect(inventory.roots).toEqual(["Templates"]);
    expect(inventory.paths).toEqual([]);
    expect(inventory.globs).toEqual([...DEFAULT_EXCLUDE_GLOBS]);
    expect(inventory.complete).toBe(false);
    expect(inventory.diagnostics.map(item => item.message).join("\n")).toMatch(/additional sources may appear/i);
    await expect(excludedNoteMatcher(vault)).rejects.toThrow(/NOTE_EXCLUSION_RESOLUTION_FAILED: \.oms\/taxonomy\.json/);
    await expect(managedSourceExclusionMatcher(vault)).rejects.toThrow(/NOTE_EXCLUSION_RESOLUTION_FAILED: \.oms\/taxonomy\.json/);
  });

  it("does not trust duplicate JSON last-wins declarations", async () => {
    const vault = await makeVault({
      ".oms/template-policy.json": `{"version":5,"revision":1,"templates":{"flower":{"source":{"path":"Templates/first.md"}}},"templates":{"flower":{"source":{"path":"Templates/second.md"}}}}`,
      "Templates/first.md": "first",
      "Templates/second.md": "second",
      "notes/idea.md": "ordinary",
    });
    const inventory = await readSourceExclusions(vault);
    expect(inventory.paths).toEqual([]);
    expect(inventory.complete).toBe(false);
    expect(inventory.diagnostics).toEqual([expect.objectContaining({ code: "SOURCE_CONTROL_AMBIGUOUS" })]);
    const lexical = await excludedNoteMatcher(vault);
    expect(lexical("Templates/first.md")).toBe(false);
    expect(lexical("Templates/second.md")).toBe(false);
    expect(lexical("notes/idea.md")).toBe(false);
  });

  it("retains a safe explicit source ref when an unrelated V5 rule is invalid", async () => {
    const text = policy();
    const parsed = JSON.parse(text) as { templates: { flower: { fields: Record<string, unknown> } } };
    parsed.templates.flower.fields = { title: { minimum: 1 } };
    const vault = await makeVault({
      ".oms/template-policy.json": JSON.stringify(parsed),
      "Templates/flower.md": "source",
      "notes/idea.md": "ordinary",
    });
    const inventory = await readSourceExclusions(vault);
    expect(inventory.paths).toEqual(["Templates/flower.md"]);
    expect(inventory.complete).toBe(false);
    expect(inventory.diagnostics).toEqual([expect.objectContaining({ code: "SOURCE_POLICY_PARTIAL" })]);
    expect((await excludedNoteMatcher(vault))("notes/idea.md")).toBe(false);
  });

  it("keeps literal V4 and V3 source declarations without activating their contracts", async () => {
    const v4 = await makeVault({
      ".oms/template-policy.json": JSON.stringify({
        version: 4,
        default: { source: { path: "Templates/default.md" } },
        templates: { imported: { source: { path: "Sources/raw.md" } }, broken: { fields: { score: { minimum: "bad" } } } },
      }),
      "Sources/raw.md": "<%* raw %>",
      "notes/idea.md": "ordinary",
    });
    const historical = await readSourceExclusions(v4);
    expect(historical.paths).toEqual(["Sources/raw.md", "Templates/default.md"]);
    expect(historical.complete).toBe(false);
    expect(historical.diagnostics).toEqual([expect.objectContaining({ code: "SOURCE_LEGACY_DECLARATION" })]);
    expect((await excludedNoteMatcher(v4))("Sources/raw.md")).toBe(true);
    expect((await excludedNoteMatcher(v4))("notes/idea.md")).toBe(false);

    const v3 = await makeVault({
      ".oms/template-policy.json": JSON.stringify({ version: 3, templates: { old: { source: { path: "Sources/legacy.md" } } } }),
      "Sources/legacy.md": "legacy",
    });
    expect((await readSourceExclusions(v3)).paths).toEqual(["Sources/legacy.md"]);

    const retired = await makeVault({
      ".oms/template-policy.json": JSON.stringify({ version: 3, templates: { old: { sourcePath: "Sources/legacy.md" } } }),
      "Sources/legacy.md": "legacy",
    });
    expect((await readSourceExclusions(retired)).paths).toEqual([]);
    expect((await excludedNoteMatcher(retired))("Sources/legacy.md")).toBe(false);
  });

  it("rejects unsafe, traversal, symlink, and hardlink controls and sources", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "oms-note-exclude-outside-"));
    roots.push(await realpath(outside));
    await writeFile(path.join(outside, "private.md"), "private");
    const vault = await makeVault({
      ".oms/settings.json": JSON.stringify({ version: 1, vaultId: VAULT_ID, templateRoots: ["../outside"] }),
      ".oms/template-policy.json": JSON.stringify({
        version: 5,
        revision: 1,
        templates: {
          escaped: { status: "active", source: { identity: "escaped", path: "../private.md", rawDigest: SOURCE_DIGEST } },
          linked: { status: "active", source: { identity: "linked", path: "Aliases/copy.md", rawDigest: SOURCE_DIGEST } },
        },
      }),
      "authored/original.md": "original",
    });
    await mkdir(path.join(vault, "Aliases"));
    await symlink(path.join(outside, "private.md"), path.join(vault, "Aliases", "copy.md"));
    const inventory = await readSourceExclusions(vault);
    expect(inventory.roots).toEqual([]);
    expect(inventory.paths).toEqual(["Aliases/copy.md"]);
    expect(inventory.paths).not.toContain("../private.md");
    expect(inventory.complete).toBe(false);
    expect(inventory.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(["VAULT_SETTINGS_INVALID", "SOURCE_REGISTRATION_NONCANONICAL", "SOURCE_ALIAS_UNSAFE"]));
    expect(inventory.diagnostics.find(item => item.code === "SOURCE_ALIAS_UNSAFE")?.message).toMatch(/^Aliases\/copy\.md resolves outside the vault/);
    const isExcluded = await managedSourceExclusionMatcher(vault);
    await expect(isExcluded("Aliases/copy.md")).resolves.toBe(true);
    await expect(isExcluded("notes/idea.md")).resolves.toBe(false);
  });

  it("classifies a hardlinked registered source without dropping its lexical exclusion", async () => {
    const vault = await makeVault({
      ".oms/template-policy.json": policy("authored/hard.md"),
      "authored/original.md": "original",
      "notes/idea.md": "ordinary",
    });
    await link(path.join(vault, "authored", "original.md"), path.join(vault, "authored", "hard.md"));
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

  it("excludes a missing registered source lexically and a confined alias deliberately", async () => {
    const vault = await makeVault({
      ".oms/template-policy.json": policy("Templates/missing.md"),
      "authored/नोट 이름.md": "---\ntitle: template\n---\n",
    });
    await mkdir(path.join(vault, "aliases"));
    await symlink(path.join(vault, "authored", "नोट 이름.md"), path.join(vault, "aliases", "copy.md"));
    const inventory = await readSourceExclusions(vault);
    expect(inventory.paths).toEqual(["Templates/missing.md"]);
    const isExcluded = await managedSourceExclusionMatcher(vault, ["authored/नोट 이름.md"]);
    await expect(isExcluded("authored/नोट 이름.md")).resolves.toBe(true);
    await expect(isExcluded("aliases/copy.md")).resolves.toBe(true);
    await expect(isExcluded("Templates/missing.md")).resolves.toBe(true);
    await expect(isExcluded("notes/idea.md")).resolves.toBe(false);
    await expect(isExcluded("notes/ordinary.md")).resolves.toBe(false);
  });

  it("observes a settings edit in the same process and creates no cache", async () => {
    const vault = await makeVault({ ".oms/settings.json": settings(["Templates"]) });
    const before = await readSourceExclusions(vault);
    expect(before.roots).toEqual(["Templates"]);
    await writeFile(path.join(vault, ".oms", "settings.json"), settings(["Library"]));
    const after = await readSourceExclusions(vault);
    expect(after.roots).toEqual(["Library"]);
    expect(after.digest).not.toBe(before.digest);
    expect((await lstat(path.join(vault, ".oms"))).isDirectory()).toBe(true);
    await expect(lstat(path.join(vault, ".oms", "index"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(vault, ".oms", "cache"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("excludes a settings root before the edit and the replacement root after it", async () => {
    const vault = await makeVault({
      ".oms/settings.json": settings(["Templates"]),
      ".oms/taxonomy.json": JSON.stringify({ exclude: ["drafts/**"] }),
      "Templates/discovered.md": "unregistered",
      "Library/discovered.md": "later root",
      "drafts/unfinished.md": "draft",
      "notes/idea.md": "ordinary",
    });
    const before = await excludedNoteMatcher(vault);
    expect(before("Templates/discovered.md")).toBe(true);
    expect(before("Library/discovered.md")).toBe(false);
    expect(before("drafts/unfinished.md")).toBe(true);
    await writeFile(path.join(vault, ".oms", "settings.json"), settings(["Library"]));
    const after = await excludedNoteMatcher(vault);
    expect(after("Templates/discovered.md")).toBe(false);
    expect(after("Library/discovered.md")).toBe(true);
    expect(after("drafts/unfinished.md")).toBe(true);
    const supplied = await managedSourceExclusionMatcher(vault, []);
    await expect(supplied("Library/discovered.md")).resolves.toBe(true);
    await expect(supplied("drafts/unfinished.md")).resolves.toBe(true);
    await expect(supplied("notes/idea.md")).resolves.toBe(false);
  });

  it("does not create OMS state while reading an empty vault", async () => {
    const vault = await makeVault();
    const inventory = await readSourceExclusions(vault);
    expect(inventory).toMatchObject({ roots: [], paths: [], globs: [...DEFAULT_EXCLUDE_GLOBS], complete: true, diagnostics: [] });
    await expect(lstat(path.join(vault, ".oms"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await excludedNoteMatcher(vault))("notes/idea.md")).toBe(false);
  });

  it("changes digest for absent, empty, invalid, and raw control bytes", async () => {
    const absent = await readSourceExclusions(await makeVault());
    const empty = await readSourceExclusions(await makeVault({ ".oms/taxonomy.json": "{}" }));
    const invalid = await readSourceExclusions(await makeVault({ ".oms/taxonomy.json": "{" }));
    const first = await makeVault({ ".oms/taxonomy.json": JSON.stringify({ exclude: ["a/**"] }) });
    const second = await makeVault({ ".oms/taxonomy.json": JSON.stringify({ exclude: ["b/**"] }) });
    const rawA = await readSourceExclusions(first);
    const rawB = await readSourceExclusions(second);
    expect(new Set([absent.digest, empty.digest, invalid.digest, rawA.digest, rawB.digest]).size).toBe(5);
    expect(rawA.complete).toBe(true);
    expect(invalid.complete).toBe(false);
  });
});

describe("excludedNoteMatcher", () => {
  it("applies only the built-in defaults when taxonomy.json has no exclude key", async () => {
    const vault = await makeVault({ ".oms/taxonomy.json": JSON.stringify({ folders: {} }) });
    const isExcluded = await excludedNoteMatcher(vault);
    expect(isExcluded(".obsidian/workspace.md")).toBe(true);
    expect(isExcluded("notes/idea.md")).toBe(false);
  });

  it("does not follow a private control outside the vault", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "oms-note-exclude-control-"));
    roots.push(await realpath(outside));
    await writeFile(path.join(outside, "taxonomy.json"), JSON.stringify({ exclude: ["notes/**"] }));
    const vault = await makeVault();
    await mkdir(path.join(vault, ".oms"));
    await symlink(path.join(outside, "taxonomy.json"), path.join(vault, ".oms", "taxonomy.json"));
    const inventory = await readSourceExclusions(vault);
    expect(inventory.globs).toEqual([...DEFAULT_EXCLUDE_GLOBS]);
    expect(inventory.complete).toBe(false);
    expect(inventory.diagnostics).toEqual([expect.objectContaining({ path: ".oms/taxonomy.json" })]);
    await expect(excludedNoteMatcher(vault)).rejects.toThrow(/NOTE_EXCLUSION_RESOLUTION_FAILED: \.oms\/taxonomy\.json/);
  });
  it("keeps NFC and NFD note identities distinct and does not retarget a noncanonical source", async () => {
    const nfc = "e\u0301".normalize("NFC");
    const nfd = "e\u0301".normalize("NFD");
    const vault = await makeVault({
      ".oms/template-policy.json": JSON.stringify({
        version: 5,
        revision: 1,
        templates: { decomposed: { status: "active", source: { identity: "decomposed", path: `Sources/${nfd}.md`, rawDigest: SOURCE_DIGEST } } },
      }),
      ".oms/taxonomy.json": JSON.stringify({ exclude: [`${nfd}/**`] }),
      [`Sources/${nfc}.md`]: "composed source",
      [`${nfc}/note.md`]: "composed note",
      [`${nfd}/note.md`]: "decomposed note",
    });
    const inventory = await readSourceExclusions(vault);
    expect(inventory.paths).toEqual([]);
    expect(inventory.globs).toContain(`${nfd}/**`);
    expect(inventory.globs).not.toContain(`${nfc}/**`);
    expect(inventory.complete).toBe(false);
    expect(inventory.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "SOURCE_REGISTRATION_NONCANONICAL" })]));
    const lexical = await excludedNoteMatcher(vault);
    expect(lexical(`Sources/${nfc}.md`)).toBe(false);
    expect(lexical(`Sources/${nfd}.md`)).toBe(false);
    expect(lexical(`${nfd}/note.md`)).toBe(true);
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
    expect(await realpath(path.join(vault, "aliases", "directory", "original.md"))).toBe(await realpath(path.join(vault, "nested", "original.md")));
    expect(await realpath(path.join(vault, "aliases", "file.md"))).toBe(await realpath(path.join(vault, "authored", "original.md")));
  });

  it("keeps a lexically safe source excluded when its file is missing, linked, hardlinked, or not a file", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "oms-note-exclude-source-"));
    roots.push(await realpath(outside));
    await writeFile(path.join(outside, "private.md"), "private");
    const vault = await makeVault({
      ".oms/template-policy.json": JSON.stringify({
        version: 5,
        revision: 1,
        templates: {
          missing: { status: "active", source: { identity: "missing", path: "Sources/missing.md", rawDigest: SOURCE_DIGEST } },
          linked: { status: "active", source: { identity: "linked", path: "Sources/linked.md", rawDigest: SOURCE_DIGEST } },
          hard: { status: "active", source: { identity: "hard", path: "Sources/hard.md", rawDigest: SOURCE_DIGEST } },
          folder: { status: "active", source: { identity: "folder", path: "Sources/folder.md", rawDigest: SOURCE_DIGEST } },
        },
      }),
      "authored/original.md": "original",
      "notes/ordinary-hardlink.md": "ordinary hardlink",
      "notes/idea.md": "ordinary",
    });
    await mkdir(path.join(vault, "Sources"));
    await symlink(path.join(outside, "private.md"), path.join(vault, "Sources", "linked.md"));
    await link(path.join(vault, "authored", "original.md"), path.join(vault, "Sources", "hard.md"));
    await link(path.join(vault, "notes", "ordinary-hardlink.md"), path.join(vault, "notes", "second-hardlink.md"));
    await mkdir(path.join(vault, "Sources", "folder.md"));
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
