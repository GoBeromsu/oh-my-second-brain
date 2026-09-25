import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildGraph, buildGraphWithWarnings, buildNodeIndex, loadCachedGraph, loadCachedGraphMeta, loadNodeIndex, nodeSourceSignature, saveCachedGraph, saveNodeIndex, TYPE_AFFINITY_MAX_GROUP, typeAffinityCapWarnings } from "./builder.js";
import { filterNodesByQueryAxes, queryFacets } from "./node.js";
import type { EngineGraphNode } from "./node.js";
import type { SearchTemplateSource } from "../retrieval/template-source.js";
import type { Digest } from "../../conventions/canonical.js";
import type { RetrievalField, RetrievalFields, TemplateId } from "../retrieval/axes.js";

let vault: string;
const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Digest;
const OTHER_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Digest;
const signature = "sha256:projection" as Digest;
const template = "note" as TemplateId;

function field(property: string, overrides: Partial<RetrievalField> = {}): RetrievalField {
  return { property, type: "string", required: false, valuePolicy: "free", intent: property, ...overrides };
}

function fields(entries: Record<string, RetrievalField>): RetrievalFields {
  const record = Object.create(null) as Record<string, RetrievalField>;
  for (const [key, value] of Object.entries(entries)) record[key] = value;
  return record;
}

function noteFields(): RetrievalFields {
  return fields({
    status: field("status", { type: "select", intent: "Status.", required: true, valuePolicy: "closed", allowedValues: ["open", "closed"] }),
    rating: field("rating", { type: "number", intent: "Rating." }),
  });
}

function inventory(paths: readonly string[]): SearchTemplateSource["exclusions"] {
  return { digest: DIGEST, roots: [], paths, globs: [], complete: true, diagnostics: [] };
}

function meta(options: { readonly digest?: Digest; readonly sourcePaths?: readonly string[]; readonly templates?: Readonly<Record<string, RetrievalFields | null>>; readonly defaultFields?: RetrievalFields } = {}): SearchTemplateSource {
  const digest = options.digest ?? DIGEST;
  const sourcePaths = options.sourcePaths ?? ["Templates/note.md"];
  return {
    digest,
    source: {
      generationDigest: digest,
      defaultFields: options.defaultFields ?? fields({ title: field("title", { intent: "Title.", required: true }) }),
      templates: options.templates ?? { [template]: noteFields() },
      globalAxes: Object.create(null) as Record<string, never>,
      sourcePaths,
    },
    exclusions: inventory(sourcePaths),
    diagnostics: [],
  };
}

/** Metadata the reader could not establish: identities and rules are unavailable. */
function unavailableMeta(digest: Digest = DIGEST, code = "TEMPLATE_POLICY_ABSENT"): SearchTemplateSource {
  return {
    digest,
    source: { generationDigest: digest, defaultFields: null, templates: null, globalAxes: null, sourcePaths: null },
    exclusions: inventory([]),
    diagnostics: [{ code, path: ".oms/settings.json", message: "no explicit contract is published" }],
  };
}

async function note(file: string, frontmatter: string, body = ""): Promise<void> {
  const destination = path.join(vault, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `---\n${frontmatter}\n---\n${body}`, "utf8");
}

async function rawNote(file: string, content: string): Promise<void> {
  const destination = path.join(vault, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
}

async function typeAffinityGroup(templateId: string, count: number, directory = templateId): Promise<void> {
  await Promise.all([...Array(count)].map((_, index) =>
    note(`notes/${directory}/${index.toString().padStart(3, "0")}.md`, `template: ${templateId}`, "body"),
  ));
}

function byPath(nodes: readonly EngineGraphNode[]): Map<string, EngineGraphNode> {
  return new Map(nodes.map(node => [node.path, node]));
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
    const nodes = await buildNodeIndex({ vaultPath: vault, meta: meta() });
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ path: "notes/a.md", template: "note", binding: "template", diagnostics: [], folder: "notes", axes: { status: ["open"], rating: [5] }, wikilinks: ["notes/b.md"] });
    expect(nodes[0]?.axes).not.toHaveProperty("rogue");
    const graph = await buildGraph({ vaultPath: vault, meta: meta() });
    expect(graph).toContainEqual({ from: "notes/a.md", to: "notes/b.md", weight: 3, kind: "wikilink" });
  });

  it("does not accept a legacy identity field as a template fallback", async () => {
    await note("notes/legacy.md", "concept: old\nstatus: open", "body");
    const nodes = await buildNodeIndex({ vaultPath: vault, meta: meta() });
    expect(nodes.map(node => node.path)).toEqual(["notes/legacy.md"]);
    expect(nodes[0]).toMatchObject({ template: null, binding: "default", diagnostics: [], axes: {} });
  });

  it("does not treat BOM-prefixed frontmatter wikilinks as body edges", async () => {
    await note("notes/target.md", "template: note", "target");
    const source = path.join(vault, "notes", "bom.md");
    await writeFile(source, "\ufeff---\r\ntemplate: note\r\nrelated: \"[[ghost]]\"\r\n---\r\nbody\r\n");
    const graph = await buildGraph({ vaultPath: vault, meta: meta() });
    expect(graph.some(edge => edge.to.includes("ghost") || edge.from.includes("ghost"))).toBe(false);
  });

  it("excludes managed template source paths from explicit and whole-vault scans", async () => {
    await note("Templates/note.md", "template: note\nstatus: source", "source");
    await note("notes/live.md", "template: note\nstatus: live", "live");
    const resolved = meta({ sourcePaths: ["Templates/note.md", "Templates/missing.md"] });
    await expect(buildNodeIndex({ vaultPath: vault, meta: resolved })).resolves.toHaveLength(1);
    await expect(buildNodeIndex({ vaultPath: vault, meta: resolved, files: ["Templates/note.md"] })).resolves.toEqual([]);
    await expect(buildNodeIndex({ vaultPath: vault, meta: resolved, files: ["notes/live.md", "Templates/note.md"] })).resolves.toHaveLength(1);
  });

  it("excludes a symlink alias of a managed template from graph scans", async () => {
    await note("Templates/note.md", "template: note\nstatus: source", "source");
    await mkdir(path.join(vault, "notes"), { recursive: true });
    await symlink(path.join(vault, "Templates", "note.md"), path.join(vault, "notes", "template-alias.md"));
    await expect(buildNodeIndex({ vaultPath: vault, meta: meta() })).resolves.toEqual([]);
    await expect(buildNodeIndex({ vaultPath: vault, meta: meta(), files: ["notes/template-alias.md"] })).resolves.toEqual([]);
  });

  it("returns an empty graph for an explicit zero-file graph-only scan without creating .oms", async () => {
    await expect(buildGraph({ vaultPath: vault, meta: meta(), files: [] })).resolves.toEqual([]);
    await expect(access(path.join(vault, ".oms"))).rejects.toThrow();
  });

  it("orders node paths and source signatures deterministically", async () => {
    await note("notes/z.md", "template: note\nstatus: open", "z");
    await note("notes/a.md", "template: note\nstatus: open", "a");
    const resolved = meta();
    expect((await buildNodeIndex({ vaultPath: vault, meta: resolved })).map(node => node.path)).toEqual(["notes/a.md", "notes/z.md"]);
    expect(await nodeSourceSignature(vault, resolved)).toBe(await nodeSourceSignature(vault, resolved));
  });

  it.each([63, 64, 65])("caps type-affinity groups at the %i-note boundary", async (count) => {
    await typeAffinityGroup("note", count);
    const graph = await buildGraph({ vaultPath: vault, meta: meta() });
    const affinity = graph.filter((edge) => edge.kind === "type-affinity");
    expect(affinity).toHaveLength(count <= TYPE_AFFINITY_MAX_GROUP ? count * (count - 1) : 0);
    const groups = new Map([["note", Array.from({ length: count }, (_, index) => String(index))]]);
    expect(typeAffinityCapWarnings(groups)).toEqual(count <= TYPE_AFFINITY_MAX_GROUP
      ? []
      : ['Skipped type-affinity edges for template "note": 65 notes exceeds the 64-note limit.']);
  });

  it("restores unbounded type-affinity only with its explicit environment opt-in", async () => {
    await typeAffinityGroup("note", 65);
    const previous = process.env["OMS_TYPE_AFFINITY_UNBOUNDED"];
    process.env["OMS_TYPE_AFFINITY_UNBOUNDED"] = "1";
    try {
      const graph = await buildGraph({ vaultPath: vault, meta: meta() });
      expect(graph.filter((edge) => edge.kind === "type-affinity")).toHaveLength(65 * 64);
      expect(typeAffinityCapWarnings(new Map([["note", Array.from({ length: 65 }, (_, index) => String(index))]]))).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env["OMS_TYPE_AFFINITY_UNBOUNDED"];
      else process.env["OMS_TYPE_AFFINITY_UNBOUNDED"] = previous;
    }
  });

  it("counts only eligible groups in a mixed type-affinity build", async () => {
    const task = "task" as TemplateId;
    await typeAffinityGroup("note", 63);
    await typeAffinityGroup(task, 65);
    const built = await buildGraphWithWarnings({
      vaultPath: vault,
      meta: meta({
        templates: {
          [template]: noteFields(),
          [task]: fields({ status: field("status", { type: "select", intent: "Status." }) }),
        },
      }),
    });
    expect(built.edges.filter((edge) => edge.kind === "type-affinity")).toHaveLength(63 * 62);
    expect(built.warnings).toEqual(['Skipped type-affinity edges for template "task": 65 notes exceeds the 64-note limit.']);
  });
});

describe("inclusive notes", () => {
  it("indexes unbound, unknown, non-string, and invalid-field notes and links all of them", async () => {
    await note("notes/bound-a.md", "template: note\nstatus: open\nrating: 5\nrogue: retained", "[[plain]] [[bound-b]]");
    await note("notes/bound-b.md", "template: note\nstatus: closed", "[[missing]]");
    await note("notes/invalid-field.md", "template: note\nstatus: nope", "kept");
    await note("notes/plain.md", "title: Hello\nstatus: open\nrogue: kept\nsources: \"[[bound-b]]\"", "[[bound-a]]");
    await note("notes/unknown.md", "template: other\nstatus: open", "[[bound-a]]");
    await note("notes/weird.md", "template: 7\nstatus: open", "[[plain]]");
    const nodes = await buildNodeIndex({ vaultPath: vault, meta: meta() });
    expect(nodes.map(node => node.path)).toEqual([
      "notes/bound-a.md",
      "notes/bound-b.md",
      "notes/invalid-field.md",
      "notes/plain.md",
      "notes/unknown.md",
      "notes/weird.md",
    ]);
    const indexed = byPath(nodes);
    expect(indexed.get("notes/bound-a.md")).toMatchObject({ template: "note", binding: "template", diagnostics: [], axes: { rating: [5], status: ["open"] }, wikilinks: ["notes/bound-b.md", "notes/plain.md"] });
    expect(indexed.get("notes/bound-a.md")?.axes).not.toHaveProperty("rogue");
    expect(indexed.get("notes/invalid-field.md")).toMatchObject({ template: "note", binding: "template", diagnostics: [], axes: { status: ["nope"] } });
    expect(indexed.get("notes/plain.md")).toMatchObject({ template: null, binding: "default", diagnostics: [], axes: { title: ["Hello"] }, wikilinks: ["notes/bound-a.md"] });
    expect(indexed.get("notes/plain.md")?.axes).not.toHaveProperty("status");
    expect(indexed.get("notes/unknown.md")).toMatchObject({ template: null, binding: "unresolved", diagnostics: ["unknown"], axes: {}, wikilinks: ["notes/bound-a.md"] });
    expect(indexed.get("notes/weird.md")).toMatchObject({ template: null, binding: "unresolved", diagnostics: ["non-string"], axes: {}, wikilinks: ["notes/plain.md"] });
    expect(nodes.some(node => node.template === "default" || node.template === "unresolved")).toBe(false);
    expect(filterNodesByQueryAxes(nodes, { template: "note" }).map(node => node.path)).toEqual(["notes/bound-a.md", "notes/bound-b.md", "notes/invalid-field.md"]);
    expect(queryFacets(nodes).filter(facet => facet.axis === "template")).toEqual([{ axis: "template", value: "note", count: 3 }]);
    const graph = await buildGraph({ vaultPath: vault, meta: meta() });
    const bound = new Set(["notes/bound-a.md", "notes/bound-b.md", "notes/invalid-field.md"]);
    const affinity = graph.filter(edge => edge.kind === "type-affinity");
    expect(affinity).toHaveLength(6);
    expect(affinity.every(edge => bound.has(edge.from) && bound.has(edge.to))).toBe(true);
    expect(graph).toContainEqual({ from: "notes/bound-a.md", to: "notes/plain.md", weight: 3, kind: "wikilink" });
    expect(graph).toContainEqual({ from: "notes/plain.md", to: "notes/bound-a.md", weight: 3, kind: "wikilink" });
    expect(graph).toContainEqual({ from: "notes/unknown.md", to: "notes/bound-a.md", weight: 3, kind: "wikilink" });
    expect(graph).toContainEqual({ from: "notes/plain.md", to: "notes/bound-b.md", weight: 4, kind: "frontmatter" });
    expect(graph).toContainEqual({ from: "notes/bound-b.md", to: "missing", weight: 0, kind: "unknown-ref" });
  });

  it("keeps malformed notes searchable and does not abort the rest of the scan", async () => {
    await note("notes/sibling.md", "template: note\nstatus: open", "sibling");
    await rawNote("notes/bad.md", "---\ntemplate: [open\n---\nneedle stays searchable\n[[sibling]]\n");
    await rawNote("notes/open.md", "---\nrawneedle stays\n");
    await rawNote("notes/alias.md", "---\nvalue: *missing\n---\naliasneedle stays searchable\n[[sibling]]\n");
    const nodes = await buildNodeIndex({ vaultPath: vault, meta: meta() });
    expect(nodes.map(node => node.path)).toEqual(["notes/alias.md", "notes/bad.md", "notes/open.md", "notes/sibling.md"]);
    const indexed = byPath(nodes);
    const bad = indexed.get("notes/bad.md");
    const open = indexed.get("notes/open.md");
    const alias = indexed.get("notes/alias.md");
    expect(bad).toMatchObject({ template: null, binding: "unresolved", axes: {}, wikilinks: ["notes/sibling.md"] });
    expect(bad?.diagnostics[0]).toBe("invalid-frontmatter");
    expect(bad?.bodyPreview).toContain("needle");
    expect(bad?.searchTerms.has("needle")).toBe(true);
    expect(open).toMatchObject({ template: null, binding: "unresolved", axes: {}, wikilinks: [] });
    expect(open?.diagnostics[0]).toBe("invalid-frontmatter");
    expect(open?.bodyPreview).toBe("");
    expect(open?.searchTerms.has("rawneedle")).toBe(true);
    expect(alias).toMatchObject({ template: null, binding: "unresolved", axes: {}, wikilinks: ["notes/sibling.md"] });
    expect(alias?.diagnostics[0]).toBe("invalid-frontmatter");
    expect(alias?.diagnostics.some(item => item.toLowerCase().includes("alias"))).toBe(true);
    expect(alias?.bodyPreview).toContain("aliasneedle");
    expect(alias?.searchTerms.has("aliasneedle")).toBe(true);
    expect(indexed.get("notes/sibling.md")).toMatchObject({ template: "note", binding: "template" });
    const graph = await buildGraph({ vaultPath: vault, meta: meta() });
    expect(graph).toContainEqual({ from: "notes/bad.md", to: "notes/sibling.md", weight: 3, kind: "wikilink" });
    expect(graph).toContainEqual({ from: "notes/alias.md", to: "notes/sibling.md", weight: 3, kind: "wikilink" });
  });

  it("skips cyclic and non-scalar declared fields without aborting the scan", async () => {
    await note("notes/sibling.md", "template: note\nstatus: open", "sibling");
    await note("notes/cycle.md", "template: note\nstatus: &cycle [*cycle]\nrating: 1.5", "cyclebody [[sibling]]");
    await note("notes/mixed.md", "template: note\nstatus: &status [open, *status]\nrating: .nan", "mixed");
    await note("notes/object.md", "template: note\nstatus: open\nrating: { nested: true }", "object");
    const nodes = await buildNodeIndex({ vaultPath: vault, meta: meta() });
    expect(nodes.map(node => node.path)).toEqual(["notes/cycle.md", "notes/mixed.md", "notes/object.md", "notes/sibling.md"]);
    const indexed = byPath(nodes);
    expect(indexed.get("notes/cycle.md")).toMatchObject({
      template: "note",
      binding: "template",
      diagnostics: ["unsupported-field:status"],
      axes: { rating: [1.5] },
      wikilinks: ["notes/sibling.md"],
    });
    expect(indexed.get("notes/cycle.md")?.searchTerms.has("cyclebody")).toBe(true);
    expect(indexed.get("notes/mixed.md")).toMatchObject({
      template: "note",
      binding: "template",
      diagnostics: ["unsupported-field:rating", "unsupported-field:status"],
      axes: { status: ["open"] },
    });
    expect(indexed.get("notes/object.md")).toMatchObject({
      template: "note",
      binding: "template",
      diagnostics: ["unsupported-field:rating"],
      axes: { status: ["open"] },
    });
    expect(indexed.get("notes/sibling.md")).toMatchObject({ template: "note", binding: "template", diagnostics: [] });
    const graph = await buildGraph({ vaultPath: vault, meta: meta() });
    expect(graph).toContainEqual({ from: "notes/cycle.md", to: "notes/sibling.md", weight: 3, kind: "wikilink" });
  });

  it("keeps finite decimals, large finite numbers, and signed zero on declared axes", async () => {
    await note("notes/decimal.md", "template: note\nstatus: open\nrating: 1.5", "decimal");
    await note("notes/large.md", "template: note\nstatus: open\nrating: 1e30", "large");
    await note("notes/signed.md", "template: note\nstatus: open\nrating: -0.0", "signed");
    const nodes = await buildNodeIndex({ vaultPath: vault, meta: meta() });
    const indexed = byPath(nodes);
    expect(indexed.get("notes/decimal.md")?.axes.rating).toEqual([1.5]);
    expect(indexed.get("notes/large.md")?.axes.rating).toEqual([1e30]);
    expect(Object.is(indexed.get("notes/signed.md")?.axes.rating?.[0], -0)).toBe(true);
    expect(indexed.get("notes/decimal.md")?.diagnostics).toEqual([]);
    expect(filterNodesByQueryAxes(nodes, { field: { rating: 1.5 } }).map(node => node.path)).toEqual(["notes/decimal.md"]);
    expect(filterNodesByQueryAxes(nodes, { field: { rating: 1e30 } }).map(node => node.path)).toEqual(["notes/large.md"]);
    expect(filterNodesByQueryAxes(nodes, { field: { rating: 0 } }).map(node => node.path)).toEqual(["notes/signed.md"]);
  });

  it("resolves ordinary aliases and does not abort on cyclic alias or source arrays", async () => {
    await note("notes/sibling.md", "template: note\nstatus: open", "sibling");
    await note("notes/named.md", "template: note\nstatus: open\naliases:\n  - Nick", "named");
    await note("notes/ref.md", "template: note\nstatus: open", "[[Nick]]");
    await rawNote("notes/loopy.md", "---\ntemplate: note\nstatus: open\naliases: &aliases [*aliases]\nsources: &sources [\"[[sibling]]\", *sources]\n---\n[[sibling]]\n");
    const graph = await buildGraph({ vaultPath: vault, meta: meta() });
    expect(graph).toContainEqual({ from: "notes/ref.md", to: "notes/named.md", weight: 3, kind: "wikilink" });
    expect(graph).toContainEqual({ from: "notes/loopy.md", to: "notes/sibling.md", weight: 3, kind: "wikilink" });
    expect(graph).toContainEqual({ from: "notes/loopy.md", to: "notes/sibling.md", weight: 4, kind: "frontmatter" });
    const loopy = (await buildNodeIndex({ vaultPath: vault, meta: meta() })).find(node => node.path === "notes/loopy.md");
    expect(loopy).toMatchObject({ template: "note", binding: "template", diagnostics: [], axes: { status: ["open"] }, wikilinks: ["notes/sibling.md"] });
  });

  it("uses declared default fields and keeps notes that miss required values", async () => {
    await note("notes/plain.md", "title: Hello\nstatus: open\nrogue: kept", "plain");
    await note("notes/partial.md", "status: open", "partial");
    await note("notes/bound.md", "template: note\nstatus: open\ntitle: Hidden\nrating: 5", "bound");
    const indexed = byPath(await buildNodeIndex({ vaultPath: vault, meta: meta() }));
    expect(indexed.get("notes/plain.md")).toMatchObject({ template: null, binding: "default", diagnostics: [], axes: { title: ["Hello"] } });
    expect(indexed.get("notes/plain.md")?.axes).not.toHaveProperty("template");
    expect(indexed.get("notes/partial.md")).toMatchObject({ template: null, binding: "default", diagnostics: [], axes: {} });
    expect(indexed.get("notes/bound.md")).toMatchObject({ template: "note", binding: "template", diagnostics: [], axes: { rating: [5], status: ["open"] } });
    expect(indexed.get("notes/bound.md")?.axes).not.toHaveProperty("title");
  });

  it("does not invent a contract when template metadata is unavailable", async () => {
    await note("notes/bound.md", "template: note\nstatus: open\nrating: 5", "[[plain]]");
    await note("notes/plain.md", "title: Hello", "[[bound]]");
    const resolved = unavailableMeta();
    const nodes = await buildNodeIndex({ vaultPath: vault, meta: resolved });
    expect(new Set(nodes.map(node => node.path))).toEqual(new Set(["Templates/note.md", "notes/bound.md", "notes/plain.md"]));
    expect(nodes.every(node => node.template === null && node.binding === "unresolved" && node.diagnostics.length === 0 && Object.keys(node.axes).length === 0)).toBe(true);
    const graph = await buildGraph({ vaultPath: vault, meta: resolved });
    expect(graph.filter(edge => edge.kind === "type-affinity")).toEqual([]);
    expect(graph).toContainEqual({ from: "notes/bound.md", to: "notes/plain.md", weight: 3, kind: "wikilink" });
    expect(graph).toContainEqual({ from: "notes/plain.md", to: "notes/bound.md", weight: 3, kind: "wikilink" });
  });
});

describe("read-only scans", () => {
  it("does not create .oms while scanning or missing a cache", async () => {
    await note("notes/a.md", "template: note\nstatus: open", "body");
    await buildNodeIndex({ vaultPath: vault, meta: meta() });
    await buildGraph({ vaultPath: vault, meta: meta() });
    await nodeSourceSignature(vault, meta());
    await expect(loadNodeIndex(path.join(vault, ".oms", "engine", "node-index.json"), DIGEST, signature)).resolves.toBeNull();
    await expect(loadCachedGraph(path.join(vault, ".oms", "engine", "graph.json"), signature)).resolves.toBeNull();
    await expect(loadCachedGraphMeta(path.join(vault, ".oms", "engine", "graph.json"), signature)).resolves.toBeNull();
    await expect(access(path.join(vault, ".oms"))).rejects.toThrow();
  });

  it("refuses paths that escape the vault", async () => {
    await expect(buildGraph({ vaultPath: vault, meta: meta(), files: ["/etc/hosts"] })).rejects.toThrow(/vault-relative/);
    await expect(buildNodeIndex({ vaultPath: vault, meta: meta(), files: ["../outside.md"] })).rejects.toThrow(/escapes the configured vault root/);
    const outside = path.join(path.dirname(vault), `oms-outside-${path.basename(vault)}.md`);
    try {
      await writeFile(outside, "outside", "utf8");
      await mkdir(path.join(vault, "notes"), { recursive: true });
      await symlink(outside, path.join(vault, "notes", "escape.md"));
      await expect(buildNodeIndex({ vaultPath: vault, meta: meta() })).rejects.toThrow(/escapes the configured vault root/);
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("propagates template and exclusion failures instead of returning an empty graph", async () => {
    await note("notes/a.md", "template: note\nstatus: open", "body");
    const broken = { digest: DIGEST, source: { templates: {} }, exclusions: inventory([]), diagnostics: [] } as unknown as SearchTemplateSource;
    await expect(buildNodeIndex({ vaultPath: vault, meta: broken })).rejects.toThrow(/TEMPLATE_AXIS_UNDECLARED_FIELD/);
    // An unreadable declared exclusion channel must block rather than scan unfiltered.
    await mkdir(path.join(vault, ".obsidian"));
    await writeFile(path.join(vault, ".obsidian", "templates.json"), "{", "utf8");
    await expect(buildGraph({ vaultPath: vault, meta: meta() })).rejects.toThrow(/NOTE_EXCLUSION_RESOLUTION_FAILED/);
  });
});

describe("projection-bound cache", () => {
  it("requires exact projection and source signatures and treats older versions as misses", async () => {
    const cache = path.join(vault, "cache.json");
    await saveCachedGraph(cache, [], signature);
    expect(JSON.parse(await readFile(cache, "utf8")).version).toBe(3);
    await expect(loadCachedGraph(cache, signature)).resolves.toEqual([]);
    expect((await loadCachedGraphMeta(cache, signature))?.edges).toEqual([]);
    await expect(loadCachedGraph(cache, "sha256:other" as Digest)).rejects.toThrow(/stale/);
    await writeFile(cache, JSON.stringify({ version: 2, projectionSignature: signature, edges: [{ from: "a", to: "b", weight: 1, kind: "wikilink" }] }), "utf8");
    await expect(loadCachedGraph(cache, signature)).resolves.toBeNull();
    await expect(loadCachedGraphMeta(cache, signature)).resolves.toBeNull();
    await writeFile(cache, JSON.stringify({ version: 3, projectionSignature: signature, edges: [{ from: 1 }] }), "utf8");
    await expect(loadCachedGraph(cache, signature)).rejects.toThrow(/invalid format/);

    await note("notes/bound.md", "template: note\nstatus: open", "bound");
    await note("notes/plain.md", "title: Hello", "plain");
    await note("notes/unknown.md", "template: other", "unknown");
    const resolved = meta();
    const source = await nodeSourceSignature(vault, resolved);
    const nodes = await buildNodeIndex({ vaultPath: vault, meta: resolved });
    await saveNodeIndex(cache, nodes, source, signature);
    expect(JSON.parse(await readFile(cache, "utf8")).version).toBe(4);
    const loaded = await loadNodeIndex(cache, source, signature);
    expect(loaded).toHaveLength(3);
    const roundTrip = (entries: readonly EngineGraphNode[]) => entries.map(node => ({ ...node, searchTerms: [...node.searchTerms].sort() }));
    expect(roundTrip(loaded ?? [])).toEqual(roundTrip(nodes));
    expect(loaded?.find(node => node.path === "notes/plain.md")).toMatchObject({ template: null, binding: "default", diagnostics: [] });
    expect(loaded?.find(node => node.path === "notes/unknown.md")).toMatchObject({ template: null, binding: "unresolved", diagnostics: ["unknown"] });
    await expect(loadNodeIndex(cache, source, "sha256:other" as Digest)).rejects.toThrow(/stale/);
    await expect(loadNodeIndex(cache, await nodeSourceSignature(vault, meta({ digest: OTHER_DIGEST })), signature)).rejects.toThrow(/stale/);
    await writeFile(cache, JSON.stringify({ version: 3, sourceSignature: source, projectionSignature: signature, nodes: [{ path: "notes/bound.md", template: "note", folder: "notes", axes: {}, wikilinks: [], bodyPreview: "", searchTerms: [] }] }), "utf8");
    await expect(loadNodeIndex(cache, source, signature)).resolves.toBeNull();
  });

  it("rejects a current node cache that breaks the nullable template or new fields", async () => {
    await note("notes/a.md", "template: note\nstatus: open", "a");
    const cache = path.join(vault, "nodes.json");
    const source = await nodeSourceSignature(vault, meta());
    const base = { path: "notes/a.md", folder: "notes", axes: {}, wikilinks: [], bodyPreview: "", searchTerms: ["a"] };
    const cases = [
      ["template", { template: 1, binding: "unresolved", diagnostics: [] }],
      ["binding", { template: null, diagnostics: [] }],
      ["diagnostics", { template: null, binding: "unresolved", diagnostics: "unknown" }],
    ] as const;
    for (const [label, overrides] of cases) {
      await writeFile(cache, JSON.stringify({ version: 4, sourceSignature: source, projectionSignature: signature, nodes: [{ ...base, ...overrides }] }), "utf8");
      await expect(loadNodeIndex(cache, source, signature), label).rejects.toThrow(/invalid format/);
    }
    await writeFile(cache, JSON.stringify({ version: 4, sourceSignature: source, projectionSignature: signature, nodes: [{ ...base, template: null, binding: "default", diagnostics: [] }] }), "utf8");
    await expect(loadNodeIndex(cache, source, signature)).resolves.toMatchObject([{ template: null, binding: "default", diagnostics: [] }]);
  });

  it("changes the node source signature when the metadata digest, exclusions, or note bytes change", async () => {
    await note("notes/a.md", "template: note\nstatus: open", "alpha");
    const available = meta();
    const first = await nodeSourceSignature(vault, available);
    expect(await nodeSourceSignature(vault, available)).toBe(first);
    expect(await nodeSourceSignature(vault, meta({ digest: OTHER_DIGEST }))).not.toBe(first);
    expect(await nodeSourceSignature(vault, unavailableMeta(DIGEST))).not.toBe(first);
    expect(await nodeSourceSignature(vault, unavailableMeta(OTHER_DIGEST))).not.toBe(await nodeSourceSignature(vault, unavailableMeta(DIGEST)));
    const missingA = await nodeSourceSignature(vault, meta({ sourcePaths: ["Templates/note.md", "Templates/missing-a.md"] }));
    const missingB = await nodeSourceSignature(vault, meta({ sourcePaths: ["Templates/note.md", "Templates/missing-b.md"] }));
    expect(missingA).not.toBe(missingB);
    await note("notes/a.md", "template: note\nstatus: open", "beta");
    expect(await nodeSourceSignature(vault, available)).not.toBe(first);
  });
});
