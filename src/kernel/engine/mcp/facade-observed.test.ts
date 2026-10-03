import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assembleLiveLexicalEngine, type AssembledEngine } from "../assemble.js";
import { LiveLexicalSession } from "../embed/live-lexical.js";
import { AxisObservationStore } from "../axes/store.js";
import { syncEngineStore } from "../embed/sync.js";
import { writeContractVault } from "../../../../test/fixtures/contract-vault-fixture.js";
import { normalizeQueryOptions, PUBLIC_FACET_SUMMARY_MAX_BYTES } from "./query-mapper.js";
import { normalizeSearchRequest } from "../../searchbackend/search-backend.js";
import type { McpSemanticQueryOptions } from "./types.js";

let root: string;
let vault: string;
let dbPath: string;
const engines: AssembledEngine[] = [];
const sessions: LiveLexicalSession[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "oms-observed-live-"));
  vault = path.join(root, "vault"); dbPath = path.join(root, "engine.sqlite");
  await mkdir(vault);
});
afterEach(async () => {
  await Promise.all(engines.splice(0).map(engine => engine.dispose()));
  await Promise.all(sessions.splice(0).map(session => session.dispose()));
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function engine(selected?: LiveLexicalSession, extras = {}): AssembledEngine {
  const result = assembleLiveLexicalEngine({ vault, dbPath, modelEnv: {}, installedModelsReceipt: { version: 1, models: [] }, ...extras }, selected);
  engines.push(result); return result;
}
async function note(name: string, fields: string, body = "needle useful content"): Promise<void> {
  await mkdir(path.dirname(path.join(vault, name)), { recursive: true });
  await writeFile(path.join(vault, name), `---\n${fields}\n---\n${body}\n`);
}
async function image(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else result[path.relative(directory, filename)] = createHash("sha256").update(await readFile(filename)).digest("hex");
    }
  };
  await visit(directory); return result;
}

describe("live observed metadata query integration", () => {
  it("intersects metadata with native FTS before candidateLimit and keeps discovery ahead of hit limits", async () => {
    for (let i = 0; i < 100; i++) await note(`noise-${i}.md`, "subject: other", "needle");
    await note("a.md", "subject: science\nscore: 7", "needle long useful material about science");
    await note("b.md", "subject: [science, research]\nscore: [unknown, 8]", "needle another long useful science passage");
    await note("unrelated.md", "subject: science\nscore: 9", "no lexical match");
    const adapter = engine().adapter;
    const result = await adapter.semanticQuery({ query: "needle", candidateLimit: 1, limit: 1, observed: { field: { subject: "science", score: { gte: 7 } }, discover: { key: "subject" } } });
    expect(result.available).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(["a.md", "b.md"]).toContain(result.hits[0]?.path);
    expect(result).toMatchObject({ totalCount: 1, observed: { discovery: { kind: "values", values: [{ value: "research", count: 1 }, { value: "science", count: 2 }] } } });
    const unmatched = await adapter.semanticQuery({ query: "absentword", observed: { field: { subject: "science" }, discover: { key: "subject" } } });
    expect(unmatched).toMatchObject({ available: true, totalCount: 0, observed: { discovery: { values: [], totalCount: 0 } } });
  });

  it("serves metadata-only zero-hit discovery without a sealed contract or persistent index", async () => {
    await note("a.md", "subject: Science\nscore: 7");
    await note("b.md", "subject: [Science, Math]\nscore: 8");
    const adapter = engine().adapter;
    const result = await adapter.semanticQuery({ limit: 0, observed: { discover: { limit: 1 } } });
    expect(result).toMatchObject({ available: true, hits: [], totalCount: 2, observed: { discovery: { kind: "keys", keys: [{ key: "score", count: 2 }], totalCount: 2 } } });
    const typed = await adapter.semanticQuery({ axes: { field: { subject: "science" } }, observed: { field: { subject: "science" } } });
    expect(typed).toMatchObject({ available: false, reason: expect.stringContaining("TEMPLATE_SNAPSHOT_UNAVAILABLE") });
    const ordinary = await adapter.semanticQuery({ query: "needle", limit: 1 });
    expect(ordinary.available).toBe(true);
    expect(ordinary).not.toHaveProperty("observed");
  });

  it("bounds ordinary oversized facets while preserving zero-hit observed discovery", async () => {
    const oversized = "x".repeat(65_536);
    await writeContractVault(vault, {
      properties: { declared: { type: "text", intent: "Synthetic declared field." } },
      templates: { fixture: { fields: ["declared"], optionalFields: ["declared"], rawSource: { path: "Templates/fixture.md", bytes: "Synthetic template source." } } },
      obsidianTypes: { declared: "text" },
    });
    await note("a.md", `template: fixture\ndeclared: ${oversized}`);
    const adapter = engine().adapter;
    const ordinary = await adapter.semanticQuery({ query: "needle", limit: 0 });
    expect(ordinary).toMatchObject({ available: true, totalCount: 1, hits: [], cursor: "0" });
    expect(ordinary.facets.some(facet => facet.key === "declared")).toBe(false);
    expect(ordinary.receipt.warnings).toContainEqual(expect.stringContaining("Facet byte limits omitted entries without shortening them"));
    expect(Buffer.byteLength(JSON.stringify(ordinary.facets))).toBeLessThanOrEqual(PUBLIC_FACET_SUMMARY_MAX_BYTES);
    const hits = await adapter.semanticQuery({ query: "needle", limit: 5 });
    expect(hits).toMatchObject({ available: true, totalCount: 1, hits: [{ path: "a.md" }], cursor: null, facets: ordinary.facets });
    expect(hits.receipt.warnings).toEqual(ordinary.receipt.warnings);
    const discovery = await adapter.semanticQuery({ query: "needle", limit: 0, observed: { discover: { key: "declared" } } });
    expect(discovery).toMatchObject({ available: true, hits: [], facets: [], observed: { discovery: { totalCount: 1, omittedCount: 1, values: [] } } });
    expect(Buffer.byteLength(JSON.stringify(discovery))).toBeLessThan(32 * 1024);
    const ordinaryAgain = await adapter.semanticQuery({ query: "needle", limit: 0 });
    expect(ordinaryAgain).toEqual(ordinary);
  });

  it("uses current edits, deletions, renames and collection/declared folder intersections", async () => {
    await note("notes/a.md", "subject: science");
    await note("other/b.md", "subject: science");
    const adapter = engine().adapter;
    const options = { query: "needle", observed: { field: { subject: "science" } }, axes: { folder: "notes" } } as const;
    expect((await adapter.semanticQuery(options)).hits.map(hit => hit.path)).toEqual(["notes/a.md"]);
    await note("notes/a.md", "subject: math");
    expect((await adapter.semanticQuery(options)).hits).toEqual([]);
    await note("notes/a.md", "subject: science");
    await rename(path.join(vault, "notes/a.md"), path.join(vault, "notes/renamed.md"));
    expect((await adapter.semanticQuery(options)).hits.map(hit => hit.path)).toEqual(["notes/renamed.md"]);
    await rm(path.join(vault, "notes/renamed.md"));
    expect((await adapter.semanticQuery(options)).hits).toEqual([]);
    expect((await adapter.semanticQuery({ observed: { field: { subject: "science" } }, collectionPath: "other" })).hits.map(hit => hit.path)).toEqual(["other/b.md"]);
  });

  it("continues discovery in a new session and rejects cursors after source edits", async () => {
    await note("a.md", "subject: [one, two, three]");
    const first = await engine().adapter.semanticQuery({ limit: 0, observed: { discover: { key: "subject", limit: 1 } } });
    if (!first.available) throw new Error(first.reason);
    const cursor = first.observed!.discovery.cursor!;
    const second = engine().adapter;
    expect(await second.semanticQuery({ limit: 0, observed: { discover: { key: "subject", limit: 1, cursor } } })).toMatchObject({ available: true, observed: { discovery: { values: [{ value: "three" }] } } });
    await note("a.md", "subject: [one, two, four]");
    expect(await second.semanticQuery({ limit: 0, observed: { discover: { key: "subject", limit: 1, cursor } } })).toMatchObject({ available: false, reason: expect.stringContaining("cursor") });
  });

  it("keeps malformed and cyclic metadata lexical while emitting bounded diagnostics", async () => {
    await note("cyclic.md", "subject: &loop [science, *loop]\nobject: {x: y}");
    await note("broken.md", "bad: [");
    const adapter = engine().adapter;
    const result = await adapter.semanticQuery({ query: "needle", observed: { discover: { key: "subject" } } });
    expect(result.available).toBe(true);
    expect(result.hits.map(hit => hit.path).sort()).toEqual(["broken.md", "cyclic.md"]);
    expect(result.receipt.warnings.some(warning => warning.includes("1 notes") && warning.includes("2 fields"))).toBe(true);
    expect(await adapter.semanticQuery({ observed: { field: { subject: "science" } } })).toMatchObject({ available: true, totalCount: 1 });
  });

  it("leaves vault and persistent index bytes unchanged on observed reads", async () => {
    await note("a.md", "subject: science");
    await syncEngineStore({ vault, dbPath, embed: false });
    const before = await image(root);
    const selected = engine();
    await selected.adapter.semanticQuery({ query: "needle", observed: { field: { subject: "science" }, discover: {} } });
    await selected.adapter.semanticQuery({ limit: 0, observed: { discover: { key: "subject" } } });
    expect(await image(root)).toEqual(before);
  });

  it("closes a failed observed spill without affecting ordinary lexical reads", async () => {
    await note("a.md", "subject: science");
    const selected = new LiveLexicalSession({ vault, dbPath, maxObservedBytes: 1 }); sessions.push(selected);
    const close = vi.spyOn(AxisObservationStore.prototype, "close");
    vi.spyOn(AxisObservationStore.prototype, "copyToEphemeral").mockImplementation(() => { throw new Error("test disk failure"); });
    const adapter = engine(selected).adapter;
    expect((await adapter.semanticQuery({ query: "needle" })).available).toBe(true);
    expect(await adapter.semanticQuery({ observed: { discover: {} } })).toMatchObject({ available: false, reason: expect.stringContaining("no partial results") });
    expect(close).toHaveBeenCalled();
    expect((await adapter.semanticQuery({ query: "needle" })).available).toBe(true);
  });

  it("releases oversized observations after a bad cursor so ordinary queries never inherit spill failure", async () => {
    await note("a.md", "subject: [one, two, three]");
    const selected = new LiveLexicalSession({ vault, dbPath, maxObservedBytes: 1 }); sessions.push(selected);
    const adapter = engine(selected).adapter;
    const spill = vi.spyOn(AxisObservationStore.prototype, "copyToEphemeral").mockImplementation(() => { throw new Error("test disk failure"); });
    expect(await adapter.semanticQuery({ observed: { discover: { cursor: "junk" } } })).toMatchObject({ available: false, reason: expect.stringContaining("cursor") });
    expect(selected.retainedStorage()).toMatchObject({ observedBytes: 0 });
    expect((await adapter.semanticQuery({ query: "needle" })).available).toBe(true);
    expect(spill).not.toHaveBeenCalled();
  });

  it("spills complete observed metadata privately, preserves cursors, and cleans up at shutdown", async () => {
    await note("a.md", "subject: [one, two, three]");
    const selected = new LiveLexicalSession({ vault, dbPath, maxObservedBytes: 1 }); sessions.push(selected);
    const copies = vi.spyOn(AxisObservationStore.prototype, "copyToEphemeral");
    const adapter = engine(selected).adapter;
    const first = await adapter.semanticQuery({ limit: 0, observed: { discover: { key: "subject", limit: 1 } } });
    expect(first.available).toBe(true);
    expect(selected.retainedStorage()).toMatchObject({ observedMemory: false });
    const filename = copies.mock.calls[0]![0];
    expect(path.relative(vault, filename).startsWith("..")).toBe(true);
    expect(await readFile(filename)).toBeInstanceOf(Buffer);
    if (!first.available) throw new Error(first.reason);
    const cursor = first.observed!.discovery.cursor!;
    expect(await adapter.semanticQuery({ limit: 0, observed: { discover: { key: "subject", limit: 1, cursor } } })).toMatchObject({ available: true, observed: { discovery: { values: [{ value: "three" }] } } });
    await note("a.md", "subject: [one, two, four]");
    expect(await adapter.semanticQuery({ observed: { field: { subject: "four" } } })).toMatchObject({ available: true, totalCount: 1 });
    expect(await adapter.semanticQuery({ observed: { discover: { cursor: "junk" } } })).toMatchObject({ available: false });
    expect(selected.retainedStorage()).toMatchObject({ observedBytes: 0 });
    await expect(readFile(filename)).rejects.toMatchObject({ code: "ENOENT" });
    await selected.dispose();
    await expect(readFile(filename)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a revision race instead of returning old discovery with new hits", async () => {
    await note("a.md", "subject: science");
    const adapter = engine(undefined, { reranker: { rerank: async (_query: string, hits: readonly { docPath: string; score: number }[]) => { await note("a.md", "subject: changed"); return hits; } } }).adapter;
    const result = await adapter.semanticQuery({ query: "needle", rerank: true, observed: { discover: { key: "subject" } } });
    expect(result).toMatchObject({ available: false, receipt: { indexDrift: true } });
    expect(result).not.toHaveProperty("observed");
  });

  it("keeps simultaneous field selections isolated on one captured source generation", async () => {
    await note("a.md", "subject: science"); await note("b.md", "subject: math");
    const adapter = engine().adapter;
    const [a, b] = await Promise.all(["science", "math"].map(subject => adapter.semanticQuery({ query: "needle", observed: { field: { subject }, discover: { key: "subject" } } })));
    expect(a.hits.map(hit => hit.path)).toEqual(["a.md"]);
    expect(b.hits.map(hit => hit.path)).toEqual(["b.md"]);
    expect(a).toMatchObject({ observed: { discovery: { values: [{ value: "science", count: 1 }] } } });
    expect(b).toMatchObject({ observed: { discovery: { values: [{ value: "math", count: 1 }] } } });
  });
});

describe("observed query normalization", () => {
  it("does not send metadata-only requests through the ordinary overview branch", () => {
    const observed = { discover: {} };
    expect(normalizeQueryOptions({ observed, limit: 0 })).toMatchObject({ overview: false, subQueries: [], limit: 0 });
    expect(normalizeSearchRequest({ observed, limit: 0 })).toMatchObject({ observed, searches: [], limit: 0 });
  });
  it("rejects multi-collection discovery instead of merging incompatible cursors/counts", () => {
    expect(() => normalizeSearchRequest({ observed: { discover: {} }, collections: ["a", "b"] })).toThrow("single collectionPath");
    expect(normalizeSearchRequest({ observed: { field: { subject: "science" } }, collections: ["a", "b"] })).toMatchObject({ collections: ["a", "b"] });
  });
  it.each([{ mode: "vsearch" }, { mode: "vsearch", searches: [{ type: "lex", query: "needle" }] }, { vec: "" }, { hyde: "" }, { vec: "needle" }, { hyde: "needle" }, { query: "needle", mode: "vsearch" }, { query: "needle", strategy: { kind: "expand", profile: "qmd-v2.8.3" } }])("rejects unsupported observed channel %j", query => {
    expect(() => normalizeQueryOptions({ ...query, observed: { discover: {} } } as McpSemanticQueryOptions)).toThrow();
    expect(() => normalizeSearchRequest({ ...query, observed: { discover: {} } } as McpSemanticQueryOptions)).toThrow();
  });
});
