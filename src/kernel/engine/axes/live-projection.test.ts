import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { serialize } from "node:v8";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { parseNodeProjectionDocument } from "../graph/builder.js";
import { AxisObservationStore } from "./store.js";

const stores: AxisObservationStore[] = [];
const roots: string[] = [];
function memory(): AxisObservationStore {
  const store = new AxisObservationStore(":memory:"); stores.push(store); return store;
}
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("session-private original projection backing", () => {
  it("preserves original Date, cyclic YAML, key casing, list/scalar shape, links and UTF-16 through spill", async () => {
    const store = memory();
    const document = parseNodeProjectionDocument("notes/Mixed.md", "---\nMiXeD: '  Science  '\nList: &loop [First, *loop]\nSingle: value\n---\nPreview [[Target#Section|Shown]]", false);
    document.frontmatter.Date = new Date("2026-01-02T03:04:05Z");
    document.frontmatter.Undefined = undefined;
    document.frontmatter.Surrogate = "\ud800";
    store.replaceLiveProjection(document, "sha");
    expect(store.list()).toEqual([]);
    expect(store.readLiveProjection(document.docPath, "other-sha")).toBeUndefined();
    const root = await mkdtemp(path.join(tmpdir(), "oms-projection-backing-")); roots.push(root);
    const copy = store.copyToEphemeral(path.join(root, "spill.sqlite")); stores.push(copy);
    const result = copy.readLiveProjection(document.docPath, "sha")!;
    expect(result).toEqual(document);
    expect(result.frontmatter.Date).toBeInstanceOf(Date);
    expect(Object.hasOwn(result.frontmatter, "Undefined")).toBe(true);
    expect(result.frontmatter.Surrogate).toBe("\ud800");
    expect((result.frontmatter.List as unknown[])[1]).toBe(result.frontmatter.List);
    expect(result.frontmatter.MiXeD).toBe("  Science  ");
    expect(result.links).toEqual(document.links);
    expect(copy.list()).toEqual([]);
    // Binary backing preserves Date; observed EAV intentionally uses canonical
    // ISO strings via toAxisScalars rather than the direct record() date type.
    copy.reconcileObservedSnapshot([{ ...result, contentSha256: "sha" }], "snapshot");
    expect(copy.list({ axisKey: "Date" })).toMatchObject([{
      value: "2026-01-02t03:04:05.000z", valueType: "string", normalizedValue: "2026-01-02t03:04:05.000z",
    }]);
    expect(copy.readLiveProjection(document.docPath, "sha")!.frontmatter.Date).toEqual(new Date("2026-01-02T03:04:05Z"));
    expect(copy.readLiveProjection(document.docPath, "sha")!.frontmatter.Date).toBeInstanceOf(Date);
    copy.replaceLiveProjection({ ...document, bodyPreview: "changed" }, "new-sha");
    expect(copy.readLiveProjection(document.docPath, "sha")).toBeUndefined();
    expect(copy.readLiveProjection(document.docPath, "new-sha")?.bodyPreview).toBe("changed");
  });

  it("treats absent, version-mismatched, corrupt and incompatible rows as cache misses", () => {
    const store = memory();
    const document = parseNodeProjectionDocument("note.md", "needle", false);
    expect(store.readLiveProjection("note.md", "sha")).toBeUndefined();
    store.replaceLiveProjection(document, "sha");
    const db = (store as unknown as { db: Database.Database }).db;
    db.exec("UPDATE live_projection SET version = version + 1");
    expect(store.readLiveProjection("note.md", "sha")).toBeUndefined();
    store.replaceLiveProjection(document, "sha");
    db.prepare("UPDATE live_projection SET document = ?").run(Buffer.from("invalid v8"));
    expect(store.readLiveProjection("note.md", "sha")).toBeUndefined();
    for (const value of [null, {}, { ...document, docPath: "wrong.md" }, { ...document, retainedBytes: -1 }]) {
      db.prepare("UPDATE live_projection SET document = ?").run(serialize(value));
      expect(store.readLiveProjection("note.md", "sha")).toBeUndefined();
    }
    store.replaceLiveProjection(document, "sha");
    store.deleteLiveProjection("note.md");
    expect(store.readLiveProjection("note.md", "sha")).toBeUndefined();
  });

  it("prunes backing without mutating the last canonical snapshot; direct deletion removes both", () => {
    const store = memory();
    store.pruneLiveProjections(new Map());
    for (const docPath of ["gone.md", "kept.md"]) {
      store.replaceLiveProjection(parseNodeProjectionDocument(docPath, "needle", false), "sha");
      store.replaceNote(docPath, { Subject: "Science" });
    }
    store.pruneLiveProjections(new Map([["kept.md", "fingerprint"]]));
    expect(store.readLiveProjection("gone.md", "sha")).toBeUndefined();
    expect(store.readLiveProjection("kept.md", "sha")).toBeDefined();
    expect(store.list().map(row => row.notePath)).toEqual(["gone.md", "kept.md"]);
    store.deleteNote("gone.md");
    store.deleteNote("kept.md");
    expect(store.readLiveProjection("kept.md", "sha")).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("does not add live backing to the persistent axis index", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-projection-persistent-")); roots.push(root);
    const store = new AxisObservationStore(path.join(root, "axes.sqlite")); stores.push(store);
    expect(() => store.replaceLiveProjection(parseNodeProjectionDocument("note.md", "needle"), "sha")).toThrow("session-private");
    const db = (store as unknown as { db: Database.Database }).db;
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='live_projection'").get()).toBeUndefined();
  });
});
