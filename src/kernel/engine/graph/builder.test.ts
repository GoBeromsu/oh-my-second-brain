import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildGraph, buildNodeIndex, loadCachedGraph, loadNodeIndex, nodeSourceSignature, saveCachedGraph, saveNodeIndex } from "./builder.js";
import type { Digest, ResolvedConvention, TemplateFolderPath, TemplateId, TemplateSourcePath } from "../../templates/types.js";

let vault: string;
const signature = "sha256:projection" as Digest;
const template = "note" as TemplateId;

function convention(overrides: Partial<ResolvedConvention> = {}): ResolvedConvention {
  return {
    base: { fields: {} },
    templates: {
      [template]: {
        id: template,
        destinationClass: "managed-default",
        sourcePath: "Templates/note.md" as TemplateSourcePath,
        targetFolder: "notes" as TemplateFolderPath,
        keyOrder: ["status", "rating"],
        fields: { status: { type: "select" }, rating: { type: "number" } },
        frontmatterTemplate: {},
        body: "",
        naming: "title",
        views: [],
        inputSignature: signature,
        templateSignature: signature,
        managedSourcePaths: ["Templates/note.md" as TemplateSourcePath],
      },
    },
    globalAxes: {
      folder: { kind: "folder", key: "folder", type: "text", members: [] },
      link: { kind: "link", key: "link", type: "text", members: [] },
    },
    managedSourcePaths: ["Templates/note.md" as TemplateSourcePath],
    inputSignature: signature,
    ...overrides,
  };
}

async function note(file: string, frontmatter: string, body = ""): Promise<void> {
  const destination = path.join(vault, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `---\n${frontmatter}\n---\n${body}`, "utf8");
}

beforeEach(async () => {
  vault = await mkdtemp(path.join(tmpdir(), "oms-template-graph-"));
  await note("Templates/note.md", "template: note", "source");
});
afterEach(async () => { await rm(vault, { recursive: true, force: true }); });

describe("template-bound graph construction", () => {
  it("uses stable template identity, declared fields, and preserved folder/link axes", async () => {
    await note("notes/a.md", "template: note\nstatus: open\nrating: 5\nrogue: retained", "[[b]] text");
    await note("notes/b.md", "template: note\nstatus: closed", "body");
    const nodes = await buildNodeIndex({ vaultPath: vault, convention: convention() });
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ path: "notes/a.md", template: "note", folder: "notes", axes: { status: ["open"], rating: [5] }, wikilinks: ["notes/b.md"] });
    expect(nodes[0]?.axes).not.toHaveProperty("rogue");
    const graph = await buildGraph({ vaultPath: vault, convention: convention() });
    expect(graph).toContainEqual({ from: "notes/a.md", to: "notes/b.md", weight: 3, kind: "wikilink" });
  });

  it("does not accept a legacy identity field as a fallback", async () => {
    await note("notes/legacy.md", "concept: old\nstatus: open", "body");
    await expect(buildNodeIndex({ vaultPath: vault, convention: convention() })).resolves.toEqual([]);
    await expect(buildGraph({ vaultPath: vault, convention: convention() })).resolves.toEqual([]);
  });

  it("omits an unresolved template identity without failing the whole graph", async () => {
    await note("notes/invalid.md", "template: unknown", "body");
    await expect(buildNodeIndex({ vaultPath: vault, convention: convention() })).resolves.toEqual([]);
  });

  it("does not treat BOM-prefixed frontmatter wikilinks as body edges", async () => {
    await note("notes/target.md", "template: note", "target");
    const source = path.join(vault, "notes", "bom.md");
    await writeFile(source, "\ufeff---\r\ntemplate: note\r\nrelated: \"[[ghost]]\"\r\n---\r\nbody\r\n");
    const graph = await buildGraph({ vaultPath: vault, convention: convention() });
    expect(graph.some(edge => edge.to.includes("ghost") || edge.from.includes("ghost"))).toBe(false);
  });

  it("excludes managed template source paths from explicit and whole-vault scans", async () => {
    await note("Templates/note.md", "template: note\nstatus: source", "source");
    await note("notes/live.md", "template: note\nstatus: live", "live");
    const resolved = convention();
    await expect(buildNodeIndex({ vaultPath: vault, convention: resolved })).resolves.toHaveLength(1);
    await expect(buildNodeIndex({ vaultPath: vault, convention: resolved, files: ["Templates/note.md"] })).resolves.toEqual([]);
  });

  it("excludes a symlink alias of a managed template from graph scans", async () => {
    await note("Templates/note.md", "template: note\nstatus: source", "source");
    await mkdir(path.join(vault, "notes"), { recursive: true });
    await symlink(path.join(vault, "Templates", "note.md"), path.join(vault, "notes", "template-alias.md"));
    await expect(buildNodeIndex({ vaultPath: vault, convention: convention() })).resolves.toEqual([]);
    await expect(buildNodeIndex({ vaultPath: vault, convention: convention(), files: ["notes/template-alias.md"] })).resolves.toEqual([]);
  });

  it("returns an empty graph for an explicit zero-file graph-only scan without creating .oms", async () => {
    await expect(buildGraph({ vaultPath: vault, convention: convention(), files: [] })).resolves.toEqual([]);
    await expect(access(path.join(vault, ".oms"))).rejects.toThrow();
  });

  it("orders node paths and source signatures deterministically", async () => {
    await note("notes/z.md", "template: note\nstatus: open", "z");
    await note("notes/a.md", "template: note\nstatus: open", "a");
    const resolved = convention();
    expect((await buildNodeIndex({ vaultPath: vault, convention: resolved })).map(node => node.path)).toEqual(["notes/a.md", "notes/z.md"]);
    expect(await nodeSourceSignature(vault, resolved)).toBe(await nodeSourceSignature(vault, resolved));
  });
});

describe("projection-bound cache", () => {
  it("requires exact projection and source signatures and rejects old versions", async () => {
    const cache = path.join(vault, "cache.json");
    await saveCachedGraph(cache, [], signature);
    await expect(loadCachedGraph(cache, signature)).resolves.toEqual([]);
    await expect(loadCachedGraph(cache, "sha256:other" as Digest)).rejects.toThrow(/stale/);
    await writeFile(cache, JSON.stringify({ version: 1, edges: [] }), "utf8");
    await expect(loadCachedGraph(cache, signature)).rejects.toThrow(/rebuild explicitly/);

    await note("notes/a.md", "template: note\nstatus: open", "a");
    const resolved = convention();
    const source = await nodeSourceSignature(vault, resolved);
    const nodes = await buildNodeIndex({ vaultPath: vault, convention: resolved });
    await saveNodeIndex(cache, nodes, source, signature);
    await expect(loadNodeIndex(cache, source, signature)).resolves.toHaveLength(1);
    await expect(loadNodeIndex(cache, source, "sha256:other" as Digest)).rejects.toThrow(/stale/);
  });
});
