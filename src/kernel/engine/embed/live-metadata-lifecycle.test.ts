import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { AxisObservationStore } from "../axes/store.js";
import { LiveLexicalSession, type LexicalSnapshotSelector, type PreparedLexicalRead } from "./live-lexical.js";
import * as source from "./source.js";
import * as stores from "./store.js";
import { indexSourcesUnchanged } from "./freshness.js";

vi.mock("./store.js", async importOriginal => {
  const original = await importOriginal<typeof import("./store.js")>();
  return { ...original, openDetachedLexicalStore: vi.fn(original.openDetachedLexicalStore) };
});
vi.mock("./source.js", async importOriginal => {
  const original = await importOriginal<typeof import("./source.js")>();
  return { ...original, readDocumentSource: vi.fn(original.readDocumentSource) };
});
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, statSync: vi.fn(original.statSync) };
});

let root: string; let vault: string; let dbPath: string;
const sessions: LiveLexicalSession[] = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "oms-metadata-lifecycle-")));
  vault = path.join(root, "vault"); dbPath = path.join(root, "absent.sqlite");
  await mkdir(vault);
  await writeFile(path.join(vault, "a.md"), "---\nsubject: old\n---\nneedle first");
  await writeFile(path.join(vault, "b.md"), "---\nsubject: old\n---\nneedle second");
  vi.clearAllMocks();
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.dispose()));
  vi.restoreAllMocks(); await rm(root, { recursive: true, force: true });
});
function session(options = {}) {
  const selected = new LiveLexicalSession({ vault, dbPath, ...options });
  sessions.push(selected); return selected;
}
const select: LexicalSnapshotSelector = (snapshot, documents, store) => {
  store.reconcileObservedSnapshot(documents.map(document => ({ ...document, contentSha256: snapshot.contentSha256!.get(document.docPath)! })), JSON.stringify([...snapshot.contentSha256!].sort()));
  return { paths: store.matchObservedFields({ subject: "old" }), discover: candidatePaths => store.discoverObservedFields({ key: "subject", candidatePaths }) };
};
function metadata(selected: LiveLexicalSession, selector = select) { return selected.prepare(vault, [], 100, undefined, selector); }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("metadata generation lifecycle", () => {
  it.each([0, 1, 2, 3, 4])("pins every joined selector before a queued lexical upgrade at microtask depth %i", async depth => {
    const selected = session();
    const state = selected as unknown as { refresh(lexical?: boolean): Promise<unknown> };
    const refresh = state.refresh.bind(selected);
    let queued: Promise<PreparedLexicalRead> | undefined;
    let nested: Promise<PreparedLexicalRead> | undefined;
    let captured = 0;
    const counting: LexicalSnapshotSelector = (...args) => {
      captured++;
      if (captured === 1) nested = metadata(selected, counting);
      return select(...args);
    };
    state.refresh = lexical => {
      const promise = refresh(lexical);
      if (!lexical) void promise.then(() => {
        const tick = (remaining: number) => {
          if (remaining > 0) queueMicrotask(() => tick(remaining - 1));
          else queued ??= selected.prepare(vault, ["needle"], 100);
        };
        tick(depth);
      });
      return promise;
    };
    const original = await vi.importActual<typeof import("./store.js")>("./store.js");
    vi.mocked(stores.openDetachedLexicalStore).mockImplementation((...args) => {
      expect(captured).toBe(3);
      return original.openDetachedLexicalStore(...args);
    });
    const [first, second] = await Promise.all([metadata(selected, counting), metadata(selected, counting)]);
    const third = await nested!;
    while (queued === undefined) await new Promise(resolve => setImmediate(resolve));
    const upgraded = await queued;
    expect(first.snapshot).toBe(second.snapshot); expect(first.snapshot).toBe(third.snapshot);
    expect(first.snapshot).not.toBe(upgraded.snapshot);
    expect(first.discovery).toEqual(second.discovery); expect(first.discovery).toEqual(third.discovery);
    expect(upgraded.store.queryLex("needle", 100)).toHaveLength(2);
    expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(1);
    expect(await indexSourcesUnchanged(first.snapshot)).toBe(true);
  });

  it("lets an observed request join an already lexical generation without another refresh", async () => {
    const selected = session();
    const [lexical, observed] = await Promise.all([selected.prepare(vault, ["needle"], 100), metadata(selected)]);
    expect(lexical.snapshot).toBe(observed.snapshot);
    expect(lexical.store.queryLex("needle", 100)).toHaveLength(2);
    expect(observed.candidatePaths).toEqual(["a.md", "b.md"]);
    expect(source.readDocumentSource).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "source failure", "spill failure"])("rejects a queued upgrade after disposal while %s readers drain", async outcome => {
    const selected = session({ maxProjectionBytes: 0, maxObservedBytes: 1 });
    const entered = deferred(); const released = deferred();
    const original = await vi.importActual<typeof import("./source.js")>("./source.js");
    vi.mocked(source.readDocumentSource).mockImplementation(async (...args) => {
      if (args[1] === "a.md" && outcome === "source failure") throw new Error("source failure");
      if (args[1] === "b.md") { entered.resolve(); await released.promise; }
      return original.readDocumentSource(...args);
    });
    if (outcome === "spill failure") vi.spyOn(AxisObservationStore.prototype, "copyToEphemeral").mockImplementationOnce(() => { throw new Error("spill failure"); });
    let settled = false; let disposed = false;
    const observed = metadata(selected).catch(error => error as Error).finally(() => { settled = true; });
    await entered.promise;
    const queued = selected.prepare(vault, ["needle"], 100).catch(error => error as Error);
    const disposal = selected.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false); expect(disposed).toBe(false);
    expect(stores.openDetachedLexicalStore).not.toHaveBeenCalled();
    released.resolve();
    const result = await observed;
    if (outcome === "success") expect(result).toMatchObject({ candidatePaths: ["a.md", "b.md"] });
    else expect(result).toBeInstanceOf(Error);
    expect(await queued).toMatchObject({ message: "Live lexical session is closed." });
    await disposal;
    expect(stores.openDetachedLexicalStore).not.toHaveBeenCalled();
    expect(selected.retainedStorage()).toMatchObject({ bytes: 0, observedBytes: 0, projectionBytes: 0 });
  });

  it("retries an admitted upgrade after a failed metadata generation fully drains", async () => {
    const selected = session(); const entered = deferred(); const released = deferred();
    const original = await vi.importActual<typeof import("./source.js")>("./source.js");
    let failed = false;
    vi.mocked(source.readDocumentSource).mockImplementation(async (...args) => {
      if (args[1] === "a.md" && !failed) { failed = true; throw new Error("first capture failed"); }
      if (args[1] === "b.md") { entered.resolve(); await released.promise; }
      return original.readDocumentSource(...args);
    });
    const first = metadata(selected).catch(error => error as Error); await entered.promise;
    const next = selected.prepare(vault, ["needle"], 100);
    expect(stores.openDetachedLexicalStore).not.toHaveBeenCalled();
    released.resolve();
    expect(await first).toMatchObject({ message: "first capture failed" });
    expect((await next).store.queryLex("needle", 100)).toHaveLength(2);
    expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(1);
  });

  it("keeps the last complete source inventory after a partial capture and recovers failed backing", async () => {
    const selected = session({ maxProjectionBytes: 0, maxObservedBytes: 1 });
    await metadata(selected);
    const state = selected as unknown as { sourceInventory: Map<string, source.DocumentSource>; temporaryDirectory: string };
    const before = state.sourceInventory;
    await writeFile(path.join(vault, "a.md"), "---\nsubject: new\n---\nreplacement");
    await writeFile(path.join(vault, "b.md"), "---\nsubject: new\n---\nreplacement");
    const original = await vi.importActual<typeof import("./source.js")>("./source.js");
    vi.mocked(source.readDocumentSource).mockImplementationOnce((...args) => original.readDocumentSource(...args)).mockRejectedValueOnce(new Error("partial capture"));
    await expect(metadata(selected)).rejects.toThrow("partial capture");
    expect(state.sourceInventory).toBe(before);
    expect(selected.retainedStorage().observedBytes).toBe(0);
    expect(await readdir(state.temporaryDirectory)).toEqual([]);
    expect((await metadata(selected)).candidatePaths).toEqual([]);
    expect(state.sourceInventory).not.toBe(before);
    expect(state.sourceInventory.size).toBe(2);
    expect(stores.openDetachedLexicalStore).not.toHaveBeenCalled();
  });

  it("recovers a failed first lexical upgrade without certifying metadata as lexical complete", async () => {
    const selected = session(); await metadata(selected);
    vi.mocked(stores.openDetachedLexicalStore).mockImplementationOnce(() => { throw new Error("seed failed"); });
    await expect(selected.prepare(vault, ["needle"], 100)).rejects.toThrow("seed failed");
    expect(selected.retainedStorage().bytes).toBe(0);
    await metadata(selected);
    expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(1);
    expect((await selected.prepare(vault, ["needle"], 100)).store.queryLex("needle", 100)).toHaveLength(2);
    expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(2);
  });

  it("rejects root identity changes during metadata capture before publishing its source map", async () => {
    const selected = session();
    const originalFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const originalSource = await vi.importActual<typeof import("./source.js")>("./source.js");
    let changed = false;
    vi.mocked(fs.statSync).mockImplementation((...args: Parameters<typeof originalFs.statSync>) => {
      const result = originalFs.statSync(...args);
      return changed && args[0] === vault ? Object.assign(result, { ino: BigInt(result.ino) + 1n }) : result;
    });
    vi.mocked(source.readDocumentSource).mockImplementationOnce(async (...args) => {
      const result = await originalSource.readDocumentSource(...args); changed = true; return result;
    });
    await expect(metadata(selected)).rejects.toThrow("vault identity changed");
    expect((selected as unknown as { sourceInventory: Map<string, unknown> }).sourceInventory.size).toBe(0);
    expect((await metadata(selected)).candidatePaths).toEqual(["a.md", "b.md"]);
    expect(stores.openDetachedLexicalStore).not.toHaveBeenCalled();
  });

  it("captures a replaced vault and keeps external-path confinement on metadata-only requests", async () => {
    const selected = session(); await metadata(selected);
    await rename(vault, `${vault}.backup`); await mkdir(vault);
    await writeFile(path.join(vault, "a.md"), "---\nsubject: replacement\n---\nreplacement");
    const next = await metadata(selected);
    expect([...next.snapshot.files.keys()]).toEqual(["a.md"]); expect(next.candidatePaths).toEqual([]);
    const forbidden = path.join(vault, "forbidden.sqlite");
    await writeFile(forbidden, "unchanged"); await symlink(forbidden, dbPath);
    await expect(metadata(selected)).rejects.toThrow("inside the vault");
    expect(await readFile(forbidden, "utf8")).toBe("unchanged");
    expect(stores.openDetachedLexicalStore).not.toHaveBeenCalled();
  });
});
