import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { ObservedFieldFilters } from "../axes/observed-query.js";
import type { ObservedDiscoveryOptions } from "../axes/observed-discovery.js";
import { LiveLexicalSession, type LexicalSnapshotSelector } from "./live-lexical.js";
import * as source from "./source.js";
import * as stores from "./store.js";
import * as chunker from "./chunker.js";
import { indexSourcesUnchanged } from "./freshness.js";
import { syncEngineStore } from "./sync.js";
import { assembleLiveLexicalEngine } from "../assemble.js";
import { writeContractVault } from "../../../../test/fixtures/contract-vault-fixture.js";

vi.mock("./store.js", async importOriginal => {
  const original = await importOriginal<typeof import("./store.js")>();
  return { ...original, openDetachedLexicalStore: vi.fn(original.openDetachedLexicalStore) };
});
vi.mock("./source.js", async importOriginal => {
  const original = await importOriginal<typeof import("./source.js")>();
  return { ...original, readDocumentSource: vi.fn(original.readDocumentSource) };
});
vi.mock("./chunker.js", async importOriginal => {
  const original = await importOriginal<typeof import("./chunker.js")>();
  return { ...original, chunkDocument: vi.fn(original.chunkDocument) };
});

let root: string;
let vault: string;
let dbPath: string;
const sessions: LiveLexicalSession[] = [];
const budgets = [{}, { maxProjectionBytes: 0, maxObservedBytes: 1, maxMemoryBytes: 1 }];
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "oms-metadata-bootstrap-")));
  vault = path.join(root, "vault"); dbPath = path.join(root, "engine.sqlite");
  await mkdir(vault); vi.clearAllMocks();
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.dispose()));
  vi.restoreAllMocks(); await rm(root, { recursive: true, force: true });
});
function session(options = {}) {
  const selected = new LiveLexicalSession({ vault, dbPath, ...options });
  sessions.push(selected); return selected;
}
async function note(name: string, fields: string, body = "needle useful content") {
  await mkdir(path.dirname(path.join(vault, name)), { recursive: true });
  await writeFile(path.join(vault, name), `---\n${fields}\n---\n${body}\n`);
}
function selector(fields: ObservedFieldFilters = {}, discovery: ObservedDiscoveryOptions = {}): LexicalSnapshotSelector {
  return (snapshot, documents, store) => {
    store.reconcileObservedSnapshot(documents.map(document => ({ ...document, contentSha256: snapshot.contentSha256!.get(document.docPath)! })), JSON.stringify([...snapshot.contentSha256!].sort()));
    return { paths: store.matchObservedFields(fields, documents.map(document => document.docPath)),
      discover: candidatePaths => store.discoverObservedFields({ ...discovery, candidatePaths }) };
  };
}
async function metadata(selected: LiveLexicalSession, fields: ObservedFieldFilters = {}, discovery: ObservedDiscoveryOptions = {}) {
  const result = await selected.prepare(vault, [], 1000, undefined, selector(fields, discovery));
  expect(await indexSourcesUnchanged(result.snapshot)).toBe(true);
  return result;
}
async function lexical(selected: LiveLexicalSession, queries = ["needle", "replacement"], select?: LexicalSnapshotSelector) {
  const result = await selected.prepare(vault, queries, 1000, undefined, select);
  expect(await indexSourcesUnchanged(result.snapshot)).toBe(true);
  return queries.map(query => result.store.queryLex(query, 1000));
}
async function diskImage(): Promise<Record<string, string>> {
  const image: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else image[path.relative(root, filename)] = (await readFile(filename)).toString("base64");
    }
  };
  await walk(root); return image;
}

describe("observed-only metadata bootstrap", () => {
  it.each(budgets.flatMap(options => [false, true].map(persistent => ({ options, persistent }))))("does not open or chunk lexical storage, including persistent=%s", async ({ options, persistent }) => {
    await note("a.md", "subject: [Science, Math]\nscore: 7");
    await note("b.md", "subject: Math\nscore: 8");
    if (persistent) await syncEngineStore({ vault, dbPath, embed: false });
    const before = await diskImage(); vi.clearAllMocks();
    const selected = session(options);
    const first = await metadata(selected, { subject: "science" }, { key: "subject" });
    expect(first.candidatePaths).toEqual(["a.md"]);
    expect(first.discovery).toMatchObject({ kind: "values", totalCount: 2, values: [{ value: "math", count: 1 }, { value: "science", count: 1 }] });
    expect(source.readDocumentSource).toHaveBeenCalledTimes(2);
    vi.mocked(source.readDocumentSource).mockClear();
    const warm = await metadata(selected);
    expect(warm.candidatePaths).toEqual(["a.md", "b.md"]);
    expect(warm.discovery).toMatchObject({ kind: "keys", keys: [{ key: "score", count: 2 }, { key: "subject", count: 2 }] });
    expect(source.readDocumentSource).not.toHaveBeenCalled();
    expect(chunker.chunkDocument).not.toHaveBeenCalled();
    expect(stores.openDetachedLexicalStore).not.toHaveBeenCalled();
    expect(selected.retainedStorage()).toMatchObject({ bytes: 0, ...(options.maxProjectionBytes === 0 ? { projectionBytes: 0, projectionDocuments: 0, observedMemory: false } : {}) });
    expect(await diskImage()).toEqual(before);
    expect(() => first.store.queryLex("needle", 1000)).toThrow("not captured");
  });

  it("does not inspect an incompatible persistent index before metadata discovery", async () => {
    await note("a.md", "subject: Science");
    await writeFile(dbPath, "not a database");
    const before = await diskImage();
    expect((await metadata(session())).candidatePaths).toEqual(["a.md"]);
    expect(stores.openDetachedLexicalStore).not.toHaveBeenCalled();
    expect(await diskImage()).toEqual(before);
  });

  it("preserves declared-axis intersections while discovering observed-only fields", async () => {
    await writeContractVault(vault, {
      properties: { declared: { type: "text", intent: "Synthetic declared field." } },
      templates: { fixture: { fields: ["declared"], optionalFields: ["declared"], rawSource: { path: "Templates/fixture.md", bytes: "Synthetic template source." } } },
      obsidianTypes: { declared: "text" },
    });
    await note("a.md", "template: fixture\ndeclared: science\nobserved: one");
    await note("b.md", "template: fixture\ndeclared: math\nobserved: one");
    const selected = session();
    const engine = assembleLiveLexicalEngine({ vault, dbPath, modelEnv: {}, installedModelsReceipt: { version: 1, models: [] } }, selected);
    try {
      const result = await engine.adapter.semanticQuery({ axes: { field: { declared: "science" } }, observed: { field: { observed: "one" }, discover: { key: "observed" } } });
      expect(result).toMatchObject({ available: true, totalCount: 1, hits: [{ path: "a.md" }], observed: { discovery: { values: [{ value: "one", count: 1 }] } } });
      expect(stores.openDetachedLexicalStore).not.toHaveBeenCalled();
      expect(chunker.chunkDocument).not.toHaveBeenCalled();
    } finally { await engine.dispose(); }
  });

  it("rejects changed sources after metadata discovery before returning a facade result", async () => {
    await note("a.md", "subject: science");
    const selected = session();
    const prepare = selected.prepare.bind(selected);
    vi.spyOn(selected, "prepare").mockImplementationOnce(async (...args) => {
      const result = await prepare(...args);
      await note("a.md", "subject: changed");
      return result;
    });
    const engine = assembleLiveLexicalEngine({ vault, dbPath, modelEnv: {}, installedModelsReceipt: { version: 1, models: [] } }, selected);
    try {
      expect(await engine.adapter.semanticQuery({ limit: 0, observed: { discover: {} } })).toMatchObject({ available: false, receipt: { indexDrift: true } });
      expect(stores.openDetachedLexicalStore).not.toHaveBeenCalled();
      expect(chunker.chunkDocument).not.toHaveBeenCalled();
    } finally { await engine.dispose(); }
  });

  it.each(budgets)("round-trips scalar/list/date-like typed facets with storage %j", async options => {
    await note("text.md", "when: '2026-01-01T00:00:00.000Z'");
    await note("date.md", "when: !!timestamp 2026-01-01T00:00:00.000Z");
    await note("number.md", "when: 1767225600000");
    await note("boolean.md", "when: true");
    await note("boolean-text.md", "when: 'true'");
    await note("list.md", "when: ['2026-01-01T00:00:00.000Z', 1767225600000, true, 'true', true]");
    const selected = session(options);
    const page = (await metadata(selected, {}, { key: "when" })).discovery!;
    if (page.kind !== "values") throw new Error("Expected values");
    expect(page.values).toHaveLength(4);
    expect(page.values.map(value => value.count).sort()).toEqual([2, 2, 2, 3]);
    for (const facet of page.values) {
      const exact = JSON.parse(JSON.stringify(facet.selection)) as typeof facet.selection;
      const result = await metadata(selected, { when: exact });
      expect(result.candidatePaths).toHaveLength(facet.count);
    }
    // Existing observed reconciliation maps original Date values to ISO strings.
    expect((await metadata(selected, { when: { exact: { valueType: "date", value: "2026-01-01T00:00:00.000Z" } } })).candidatePaths).toEqual([]);
    expect(chunker.chunkDocument).not.toHaveBeenCalled();
  });

  it.each(budgets)("reconciles restored-mtime edits, deletions, renames, exclusions and recreated notes with %j", async options => {
    for (const name of ["a.md", "delete.md", "rename.md", "Templates/exclude.md"]) await note(name, "subject: [one, two]");
    const filename = path.join(vault, "a.md");
    await utimes(filename, 1700000000.123456, 1700000000.123456);
    const selected = session(options);
    const first = await metadata(selected, {}, { key: "subject", limit: 1 });
    const old = await stat(filename, { bigint: true });
    await note("a.md", "subject: [one, new]");
    await utimes(filename, 1700000000.123456, 1700000000.123456);
    expect((await stat(filename, { bigint: true })).mtimeNs).toBe(old.mtimeNs);
    expect((await stat(filename)).size).toBe(Number(old.size));
    await rm(path.join(vault, "delete.md"));
    await rename(path.join(vault, "rename.md"), path.join(vault, "renamed.md"));
    await mkdir(path.join(vault, ".obsidian"));
    await writeFile(path.join(vault, ".obsidian/templates.json"), JSON.stringify({ folder: "Templates" }));
    vi.mocked(source.readDocumentSource).mockClear();
    const current = await metadata(selected, { subject: "one" });
    expect(current.candidatePaths).toEqual(["a.md", "renamed.md"]);
    expect(vi.mocked(source.readDocumentSource).mock.calls.map(args => args[1]).sort()).toEqual(["a.md", "renamed.md"]);
    expect(await indexSourcesUnchanged(first.snapshot)).toBe(false);
    await expect(metadata(selected, {}, { key: "subject", limit: 1, cursor: first.discovery!.cursor! })).rejects.toThrow("cursor");
    await note("delete.md", "subject: [one, two]");
    await writeFile(path.join(vault, ".obsidian/templates.json"), JSON.stringify({ folder: "Other" }));
    expect((await metadata(selected, { subject: "one" })).candidatePaths).toEqual(["Templates/exclude.md", "a.md", "delete.md", "renamed.md"]);
    vi.mocked(source.readDocumentSource).mockClear();
    await metadata(selected);
    expect(source.readDocumentSource).not.toHaveBeenCalled();
    expect(stores.openDetachedLexicalStore).not.toHaveBeenCalled();
  });

  it("rehashes weak witnesses while avoiding a redundant projection capture", async () => {
    await note("a.md", "subject: old");
    const original = await vi.importActual<typeof import("./source.js")>("./source.js");
    vi.spyOn(source, "documentSourceFingerprint").mockResolvedValue(null);
    vi.mocked(source.readDocumentSource).mockImplementation(async (...args) => {
      const captured = await original.readDocumentSource(...args);
      return { ...captured, source: { ...captured.source, fingerprint: null } };
    });
    const selected = session(); await metadata(selected);
    vi.mocked(source.readDocumentSource).mockClear();
    expect((await metadata(selected, { subject: "old" })).candidatePaths).toEqual(["a.md"]);
    expect(source.readDocumentSource).toHaveBeenCalledTimes(2); // Inventory and final check.
    await note("a.md", "subject: new");
    expect((await metadata(selected, { subject: "old" })).candidatePaths).toEqual([]);
    expect((await metadata(selected, { subject: "new" })).candidatePaths).toEqual(["a.md"]);
    expect(chunker.chunkDocument).not.toHaveBeenCalled();
  });

  it("retains byte-mode validation when a previously strong witness becomes unavailable", async () => {
    await note("a.md", "subject: old");
    const selected = session(); await metadata(selected);
    vi.spyOn(source, "documentSourceFingerprint").mockResolvedValue(null);
    vi.mocked(source.readDocumentSource).mockClear();
    const current = await metadata(selected);
    expect(current.snapshot.byteVerifiedPaths).toEqual(new Set(["a.md"]));
    expect(current.snapshot.files.get("a.md")).toMatch(/^bytes:/u);
    expect(source.readDocumentSource).toHaveBeenCalledTimes(2);
  });

  it.each(budgets)("builds the complete canonical corpus on metadata→lexical upgrade with %j", async options => {
    await note("a.md", "subject: science", "needle needle useful content");
    await note("b.md", "subject: other", "needle another passage");
    await writeFile(path.join(vault, "empty.md"), "");
    const selected = session(options);
    await metadata(selected, { subject: "science" });
    expect(chunker.chunkDocument).not.toHaveBeenCalled();
    const actual = await lexical(selected);
    expect(chunker.chunkDocument).toHaveBeenCalledTimes(3);
    expect(actual).toEqual(await lexical(session(options)));
    expect(await lexical(selected, ["needle"], selector({ subject: "science" }, { key: "subject" }))).toEqual(await lexical(session(options), ["needle"], selector({ subject: "science" }, { key: "subject" })));
    vi.mocked(source.readDocumentSource).mockClear();
    await metadata(selected); await lexical(selected);
    expect(source.readDocumentSource).not.toHaveBeenCalled();
  });

  it.each(budgets)("keeps lexical evidence independent through lexical→metadata edit→lexical with %j", async options => {
    await note("a.md", "subject: science", "needle needle");
    await note("b.md", "subject: other", "needle shared");
    await syncEngineStore({ vault, dbPath, embed: false }); vi.clearAllMocks();
    const selected = session(options); await lexical(selected);
    await note("a.md", "subject: changed", "replacement replacement");
    await rename(path.join(vault, "b.md"), path.join(vault, "renamed.md"));
    const before = await diskImage(); vi.mocked(chunker.chunkDocument).mockClear();
    expect((await metadata(selected, { subject: "changed" })).candidatePaths).toEqual(["a.md"]);
    expect(chunker.chunkDocument).not.toHaveBeenCalled();
    vi.mocked(source.readDocumentSource).mockClear();
    const actual = await lexical(selected);
    expect(vi.mocked(source.readDocumentSource).mock.calls.map(args => args[1]).sort()).toEqual(["a.md", "renamed.md"]);
    expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(1);
    expect(actual).toEqual(await lexical(session(options)));
    expect(await diskImage()).toEqual(before);
  });

  it("releases private backing after a stale cursor and removes spill files on disposal", async () => {
    await note("a.md", "subject: [one, two, three]");
    const selected = session(budgets[1]);
    const first = await metadata(selected, {}, { key: "subject", limit: 1 });
    await note("a.md", "subject: [one, two, changed]");
    await expect(metadata(selected, {}, { key: "subject", limit: 1, cursor: first.discovery!.cursor! })).rejects.toThrow("cursor");
    expect(selected.retainedStorage()).toMatchObject({ bytes: 0, projectionBytes: 0, observedBytes: 0 });
    vi.mocked(source.readDocumentSource).mockClear();
    await metadata(selected); expect(source.readDocumentSource).toHaveBeenCalledTimes(1);
    const internal = selected as unknown as { observedDiskPath: string };
    const spilled = internal.observedDiskPath;
    expect(await readFile(spilled)).toBeInstanceOf(Buffer);
    await selected.dispose();
    await expect(readFile(spilled)).rejects.toMatchObject({ code: "ENOENT" });
    expect(stores.openDetachedLexicalStore).not.toHaveBeenCalled();
  });
});
