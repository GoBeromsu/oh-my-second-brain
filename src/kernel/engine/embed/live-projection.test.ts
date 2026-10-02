import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxisObservationStore } from "../axes/store.js";
import type { NodeProjectionDocument } from "../graph/builder.js";
import { readSearchTemplateSource } from "../retrieval/template-source.js";
import { LiveLexicalSession, type LexicalSnapshotSelector } from "./live-lexical.js";
import * as source from "./source.js";

vi.mock("./source.js", async importOriginal => {
  const original = await importOriginal<typeof import("./source.js")>();
  return { ...original, readDocumentSource: vi.fn(original.readDocumentSource) };
});

let root: string;
let vault: string;
let selected: LiveLexicalSession;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "oms-live-projection-"));
  vault = path.join(root, "vault"); await mkdir(vault);
  selected = new LiveLexicalSession({ vault, dbPath: path.join(root, "absent.sqlite"), maxProjectionBytes: 0, maxObservedBytes: 1 });
  const original = await vi.importActual<typeof import("./source.js")>("./source.js");
  vi.mocked(source.readDocumentSource).mockImplementation(original.readDocumentSource).mockClear();
});
afterEach(async () => {
  await selected.dispose();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
function internals() {
  return selected as unknown as { observations: AxisObservationStore | undefined; observedDiskPath: string | undefined; temporaryDirectory: string | undefined };
}
async function prepare(selector?: LexicalSnapshotSelector) { return selected.prepare(vault, ["needle"], 1000, undefined, selector); }

describe("live projection overflow reuse", () => {
  it("keeps original projections and request snapshots intact after edits and disposal", async () => {
    await writeFile(path.join(vault, "a.md"), "---\nMiXeD: '  Science  '\nList: &loop [One, *loop]\n---\nneedle [[b|Alias]]");
    await writeFile(path.join(vault, "b.md"), "needle target");
    let cold: readonly NodeProjectionDocument[] = [];
    const first = await prepare((snapshot, docs) => { cold = docs; return { paths: [...snapshot.files.keys()] }; });
    vi.mocked(source.readDocumentSource).mockClear();
    let warm: readonly NodeProjectionDocument[] = [];
    const second = await prepare((snapshot, docs, observations) => {
      warm = docs;
      expect(observations.list()).toEqual([]);
      return { paths: [...snapshot.files.keys()] };
    });
    expect(source.readDocumentSource).not.toHaveBeenCalled();
    expect(warm).toEqual(cold);
    const loop = warm.find(doc => doc.docPath === "a.md")!.frontmatter.List as unknown[];
    expect(loop[1]).toBe(loop);
    const meta = await readSearchTemplateSource(vault);
    expect(await second.nodeProjection(meta)).toEqual(await first.nodeProjection(meta));
    await writeFile(path.join(vault, "b.md"), "changed target");
    await prepare();
    await selected.dispose();
    expect(first.store.queryLex("needle", 1000)).toHaveLength(2);
    expect((await first.nodeProjection(meta)).find(node => node.path === "b.md")?.bodyPreview).toContain("needle");
  });

  it("reuses dense overflow bodies and recaptures only the edited note without admitting decoded documents", async () => {
    const count = 128;
    const raw = (index: number) => `---\nsubject: Science\n${Array.from({ length: 21 }, (_, key) => `key_${key}: ${index}-${"x".repeat(128)}`).join("\n")}\n---\nneedle ${index}\n`;
    await Promise.all(Array.from({ length: count }, (_, index) => writeFile(path.join(vault, `${index}.md`), raw(index))));
    expect((await prepare()).store.queryLex("needle", 1000)).toHaveLength(count);
    expect(source.readDocumentSource).toHaveBeenCalledTimes(count);
    vi.mocked(source.readDocumentSource).mockClear();
    expect((await prepare()).store.queryLex("needle", 1000)).toHaveLength(count);
    expect(source.readDocumentSource).not.toHaveBeenCalled();
    expect(selected.retainedStorage()).toMatchObject({ projectionBytes: 0, projectionDocuments: 0, observedMemory: false });
    expect(internals().observations!.list()).toEqual([]);
    await writeFile(path.join(vault, "17.md"), raw(17).replace("Science", "Math"));
    expect((await prepare()).store.queryLex("needle", 1000)).toHaveLength(count);
    expect(vi.mocked(source.readDocumentSource).mock.calls.map(args => args[1])).toEqual(["17.md"]);
    expect(await readdir(root)).toEqual(["vault"]);
  });

  it.each(["missing", "version", "sha"])("recaptures a %s backing row instead of omitting the note", async mode => {
    await writeFile(path.join(vault, "a.md"), "needle");
    const first = await prepare();
    const sha = first.snapshot.contentSha256!.get("a.md")!;
    const store = internals().observations!;
    const db = (store as unknown as { db: Database.Database }).db;
    if (mode === "missing") store.deleteLiveProjection("a.md");
    if (mode === "version") db.exec("UPDATE live_projection SET version=999");
    if (mode === "sha") db.exec("UPDATE live_projection SET content_sha256='wrong'");
    vi.mocked(source.readDocumentSource).mockClear();
    expect((await prepare()).store.queryLex("needle", 1000)).toHaveLength(1);
    expect(source.readDocumentSource).toHaveBeenCalledTimes(1);
    expect(store.readLiveProjection("a.md", sha)).toBeDefined();
  });

  it("removes edit/delete/rename/exclude rows alongside native sources and restores newly admitted notes", async () => {
    await mkdir(path.join(vault, "Templates"));
    for (const name of ["delete.md", "rename.md", "Templates/exclude.md"]) await writeFile(path.join(vault, name), "---\nSubject: Science\n---\nneedle");
    const selector: LexicalSnapshotSelector = (snapshot, docs, store) => {
      store.reconcileObservedSnapshot(docs.map(doc => ({ ...doc, contentSha256: snapshot.contentSha256!.get(doc.docPath)! })), JSON.stringify([...snapshot.contentSha256!]));
      return { paths: store.matchObservedFields({ subject: "science" }) };
    };
    const first = await prepare(selector);
    const priorShas = first.snapshot.contentSha256!;
    await rm(path.join(vault, "delete.md"));
    await rename(path.join(vault, "rename.md"), path.join(vault, "renamed.md"));
    await mkdir(path.join(vault, ".obsidian"));
    await writeFile(path.join(vault, ".obsidian/templates.json"), JSON.stringify({ folder: "Templates" }));
    vi.mocked(source.readDocumentSource).mockClear();
    const next = await prepare();
    expect(next.store.queryLex("needle", 1000).map(hit => hit.docPath)).toEqual(["renamed.md"]);
    expect(vi.mocked(source.readDocumentSource).mock.calls.map(args => args[1])).toEqual(["renamed.md"]);
    for (const [name, sha] of priorShas) expect(internals().observations!.readLiveProjection(name, sha)).toBeUndefined();
    expect(internals().observations!.list().map(row => row.notePath).sort()).toEqual(["Templates/exclude.md", "delete.md", "rename.md"]);
    expect((await prepare(selector)).candidatePaths).toEqual(["renamed.md"]);
    expect(internals().observations!.list().map(row => row.notePath)).toEqual(["renamed.md"]);
    await writeFile(path.join(vault, ".obsidian/templates.json"), JSON.stringify({ folder: "Other" }));
    expect((await prepare()).store.queryLex("needle", 1000)).toHaveLength(2);
  });

  it("incrementally reconciles rename/delete/exclusion after ordinary refresh and reinserts same-SHA returns", async () => {
    await mkdir(path.join(vault, "Templates"));
    const names = ["delete.md", "rename.md", "kept.md", "Templates/exclude.md"];
    const raw = "---\nSubject: [Science, Research]\n---\nneedle";
    for (const name of names) await writeFile(path.join(vault, name), raw);
    const replacements = vi.spyOn(AxisObservationStore.prototype, "replaceNote");
    const selector: LexicalSnapshotSelector = (snapshot, documents, store) => {
      store.reconcileObservedSnapshot(documents.map(document => ({ ...document, contentSha256: snapshot.contentSha256!.get(document.docPath)! })), JSON.stringify([...snapshot.contentSha256!].sort()));
      return { paths: store.matchObservedFields({ subject: "science" }), discover: () => store.discoverObservedFields({ key: "subject", limit: 1 }) };
    };
    const first = await prepare(selector);
    const oldCursor = first.discovery!.cursor!;
    expect(replacements).toHaveBeenCalledTimes(4);
    replacements.mockClear();
    await rm(path.join(vault, "delete.md"));
    await rename(path.join(vault, "rename.md"), path.join(vault, "renamed.md"));
    await mkdir(path.join(vault, ".obsidian"));
    await writeFile(path.join(vault, ".obsidian/templates.json"), JSON.stringify({ folder: "Templates" }));
    const ordinary = await prepare();
    expect(ordinary.store.queryLex("needle", 1000).map(hit => hit.docPath).sort()).toEqual(["kept.md", "renamed.md"]);
    expect(ordinary.candidatePaths).toBeUndefined();
    expect(ordinary.discovery).toBeUndefined();
    expect(replacements).not.toHaveBeenCalled();
    const current = await prepare(selector);
    expect(current.candidatePaths).toEqual(["kept.md", "renamed.md"]);
    expect(replacements.mock.calls.map(args => args[0])).toEqual(["renamed.md"]);
    expect([...new Set(internals().observations!.list().map(row => row.notePath))]).toEqual(["kept.md", "renamed.md"]);
    expect(() => internals().observations!.discoverObservedFields({ key: "subject", limit: 1, cursor: oldCursor })).toThrow("cursor");
    for (const name of ["delete.md", "rename.md", "Templates/exclude.md"]) {
      expect(internals().observations!.readLiveProjection(name, first.snapshot.contentSha256!.get(name)!)).toBeUndefined();
    }
    replacements.mockClear();
    await writeFile(path.join(vault, "delete.md"), raw);
    await writeFile(path.join(vault, ".obsidian/templates.json"), JSON.stringify({ folder: "Other" }));
    await prepare();
    expect(replacements).not.toHaveBeenCalled();
    const restored = await prepare(selector);
    expect(restored.snapshot.contentSha256!.get("delete.md")).toBe(first.snapshot.contentSha256!.get("delete.md"));
    expect(restored.candidatePaths).toEqual(["Templates/exclude.md", "delete.md", "kept.md", "renamed.md"]);
    expect(replacements.mock.calls.map(args => args[0]).sort()).toEqual(["Templates/exclude.md", "delete.md"]);
  });

  it("recaptures overflow bodies after a stale-cursor failure releases shared backing, then warms again", async () => {
    const raw = "---\nsubject: [science, research]\n---\nneedle";
    for (const name of ["a.md", "b.md"]) await writeFile(path.join(vault, name), raw);
    const selector = (cursor?: string): LexicalSnapshotSelector => (snapshot, documents, store) => {
      store.reconcileObservedSnapshot(documents.map(document => ({ ...document, contentSha256: snapshot.contentSha256!.get(document.docPath)! })), JSON.stringify([...snapshot.contentSha256!].sort()));
      return { paths: store.matchObservedFields({ subject: "science" }), discover: () => store.discoverObservedFields({ key: "subject", limit: 1, cursor }) };
    };
    const first = await prepare(selector());
    const cursor = first.discovery!.cursor!;
    expect(source.readDocumentSource).toHaveBeenCalledTimes(2);
    vi.mocked(source.readDocumentSource).mockClear();
    expect((await prepare(selector())).candidatePaths).toEqual(["a.md", "b.md"]);
    expect(source.readDocumentSource).not.toHaveBeenCalled();
    await writeFile(path.join(vault, "a.md"), raw.replace("research", "changed"));
    await expect(prepare(selector(cursor))).rejects.toThrow("cursor");
    expect(vi.mocked(source.readDocumentSource).mock.calls.map(args => args[1])).toEqual(["a.md"]);
    expect(selected.retainedStorage()).toMatchObject({ projectionBytes: 0, projectionDocuments: 0, observedBytes: 0 });
    vi.mocked(source.readDocumentSource).mockClear();
    const retry = await prepare(selector());
    expect(retry.candidatePaths).toEqual(["a.md", "b.md"]);
    expect(retry.store.queryLex("needle", 1000)).toHaveLength(2);
    expect(vi.mocked(source.readDocumentSource).mock.calls.map(args => args[1]).sort()).toEqual(["a.md", "b.md"]);
    vi.mocked(source.readDocumentSource).mockClear();
    expect((await prepare(selector())).candidatePaths).toEqual(["a.md", "b.md"]);
    expect(source.readDocumentSource).not.toHaveBeenCalled();
  });

  it("drains a late reader before resetting failed backing spill and recovers on an ordinary query", async () => {
    await writeFile(path.join(vault, "a.md"), "needle first");
    await writeFile(path.join(vault, "b.md"), "needle late");
    const original = await vi.importActual<typeof import("./source.js")>("./source.js");
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(source.readDocumentSource).mockImplementation(async (...args) => {
      if (args[1] === "b.md") { enter(); await released; }
      return original.readDocumentSource(...args);
    });
    vi.spyOn(AxisObservationStore.prototype, "copyToEphemeral").mockImplementationOnce(() => { throw new Error("failed spill"); });
    let settled = false;
    const failed = prepare().catch(error => { settled = true; return error as Error; });
    await entered; await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    expect(await failed).toMatchObject({ message: expect.stringContaining("no partial results") });
    expect(selected.retainedStorage()).toMatchObject({ projectionBytes: 0, projectionDocuments: 0, observedBytes: 0 });
    expect(internals().temporaryDirectory === undefined ? [] : await readdir(internals().temporaryDirectory!)).toEqual([]);
    expect((await prepare()).store.queryLex("needle", 1000)).toHaveLength(2);
    expect(selected.retainedStorage()).toMatchObject({ projectionBytes: 0, observedMemory: false });
  });

  it("keeps backing spill outside the vault and removes it on shutdown", async () => {
    await writeFile(path.join(vault, "a.md"), "needle");
    await prepare();
    const filename = internals().observedDiskPath!;
    expect(path.relative(vault, filename).startsWith("..")).toBe(true);
    expect(await readFile(filename)).toBeInstanceOf(Buffer);
    await selected.dispose();
    await expect(readFile(filename)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
