import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseNote } from "../../conventions/frontmatter.js";
import { filterNodesByQueryAxes, type EngineGraphNode } from "../graph/node.js";
import { AxisObservationStore, type ObservedMetadataDocument } from "./store.js";
import type { ObservedFieldFilters } from "./observed-query.js";
import { OBSERVED_DISCOVERY_MAX_VALUE_BYTES } from "./observed-discovery.js";

const stores: AxisObservationStore[] = [];
const roots: string[] = [];
function store(): AxisObservationStore {
  const result = new AxisObservationStore(":memory:");
  stores.push(result);
  return result;
}
function source(docPath: string, raw: string): ObservedMetadataDocument {
  const parsed = parseNote(raw);
  return { docPath, frontmatter: parsed.frontmatter, contentSha256: createHash("sha256").update(raw).digest("hex"), diagnostics: parsed.diagnostics.map(item => item.message) };
}
function node(axes: EngineGraphNode["axes"]): EngineGraphNode {
  return { path: "note.md", template: null, binding: "default", diagnostics: [], folder: "", axes, wikilinks: [], bodyPreview: "", searchTerms: new Set() };
}
afterEach(async () => {
  for (const item of stores.splice(0)) item.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("observed field predicates", () => {
  it("matches scalars and list members identically without conflating primitive types", () => {
    const db = store();
    db.replaceNote("scalar.md", { subject: "  Science ", code: 7, live: false });
    db.replaceNote("list.md", { subject: ["Science", "Math", "SCIENCE"], code: [7, "7"], live: [false] });
    db.replaceNote("string.md", { subject: "Math", code: "7", live: "false" });
    expect(db.matchObservedFields({ SUBJECT: "science" })).toEqual(["list.md", "scalar.md"]);
    expect(db.matchObservedFields({ code: 7, live: false })).toEqual(["list.md", "scalar.md"]);
    expect(db.matchObservedFields({ code: "7" })).toEqual(["list.md", "string.md"]);
    expect(db.matchObservedFields({ subject: { containsAll: ["science", "math"] } })).toEqual(["list.md"]);
    expect(db.matchObservedFields({ subject: { contains: ["science", "nope"] } })).toEqual(["list.md", "scalar.md"]);
    expect(db.matchObservedFields({ subject: { in: ["science", "nope"] } })).toEqual(["list.md", "scalar.md"]);
    expect(db.matchObservedFields({ subject: [] })).toEqual([]);
    expect(db.matchObservedFields({ missing: { containsAll: [] } })).toEqual([]);
  });

  it.each([
    [5, { gte: 5 }, true], [5, { gt: 5 }, false], [5, { lte: 5 }, true], [5, { lt: 5 }, false],
    [5, { from: 5, to: 6 }, true], [5, { between: [4, 6] }, true],
    ["2026-01-02", { from: "2026-01-01", to: "2026-01-03" }, true],
    ["2026-01-02T00:00:00Z", { in: ["2026-01-02"] }, true],
    [" Zebra ", { gt: "alpha" }, true], [false, { lte: true }, true],
  ] as const)("retains declared predicate semantics for homogeneous %s / %j", (value, predicate, expected) => {
    const db = store();
    db.replaceNote("note.md", { field: [value] });
    const filters = { field: predicate } as ObservedFieldFilters;
    const declared = filterNodesByQueryAxes([node({ field: [value] })], { field: filters }).length > 0;
    expect(declared).toBe(expected);
    expect(db.matchObservedFields(filters).length > 0).toBe(declared);
  });

  it("ignores incomparable mixed-list values while requiring a single value within each range", () => {
    const db = store();
    db.replaceNote("mixed.md", { score: ["unknown", false, 7, 2] });
    db.replaceNote("split.md", { score: [2, 9] });
    expect(db.matchObservedFields({ score: { gte: 6, lte: 8 } })).toEqual(["mixed.md"]);
    expect(db.matchObservedFields({ score: { between: [6, 8] } })).toEqual(["mixed.md"]);
    expect(() => filterNodesByQueryAxes([node({ score: ["unknown", 7] })], { field: { score: { gte: 6 } } })).toThrow("same type");
  });

  it("binds malicious field names, values, and candidate paths as data", () => {
    const db = store();
    const key = "x' OR 1=1 --";
    const value = "'); DROP TABLE axis_observation; --";
    const name = "x'); DELETE FROM axis_observation; --.md";
    db.replaceNote(name, { [key]: value });
    db.replaceNote("other.md", { other: "ok" });
    expect(db.matchObservedFields({ [key]: value }, [name])).toEqual([name]);
    expect(db.matchObservedFields({ [key]: value }, ["other.md"])).toEqual([]);
    expect(db.count()).toBe(2);
  });

  it.each([
    null, [], { x: null }, { x: Number.NaN }, { x: { nope: 1 } }, { x: { between: [1] } },
    { x: { between: [undefined, 1] } }, { x: { gte: null } }, { x: { gte: undefined } }, { x: { gte: [] } }, { x: { gte: " " } }, { x: { gte: Number.POSITIVE_INFINITY } },
    { " ": "yes" }, { x: { in: Array(257).fill("x") } }, { x: { containsAll: Array(257).fill("x") } }, { x: Array(257).fill("") },
    Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, "x"])),
  ])("rejects invalid/unbounded predicates even in an empty store: %j", invalid => {
    expect(() => store().matchObservedFields(invalid as ObservedFieldFilters)).toThrow();
  });
});

describe("observed current-note reconciliation", () => {
  it("reconciles edits, deletions, renames and preserves an empty-metadata note universe", () => {
    const db = store();
    const a = source("a.md", "---\nsubject: science\n---\nlexical");
    const b = source("b.md", "just lexical");
    expect(db.reconcileObservedSnapshot([a, b], "first")).toEqual({ malformedNotes: 0, unsupportedFields: 0 });
    expect(db.matchObservedFields({})).toEqual(["a.md", "b.md"]);
    expect(db.matchObservedFields({ subject: "science" })).toEqual(["a.md"]);
    db.reconcileObservedSnapshot([source("renamed.md", "---\nsubject: math\n---\nlexical"), b], "second");
    expect(db.matchObservedFields({ subject: "science" })).toEqual([]);
    expect(db.matchObservedFields({ subject: "math" })).toEqual(["renamed.md"]);
    db.reconcileObservedSnapshot([b], "third");
    expect(db.list()).toEqual([]);
    expect(db.matchObservedFields({})).toEqual(["b.md"]);
    expect(db.reconcileObservedSnapshot([b], "third")).toEqual({ malformedNotes: 0, unsupportedFields: 0 });
  });

  it("retains cyclic-list scalars with bounded diagnostics and skips malformed/nonscalar fields", () => {
    const db = store();
    const cyclic = source("cyclic.md", "---\nsubject: &loop [Science, *loop]\nobject: {a: b}\n---\nlexical");
    const malformed = source("malformed.md", "---\nbad: [\n---\nlexical");
    expect(db.reconcileObservedSnapshot([cyclic, malformed], "first")).toEqual({ malformedNotes: 1, unsupportedFields: 2 });
    expect(db.matchObservedFields({ subject: "science" })).toEqual(["cyclic.md"]);
    expect(db.matchObservedFields({})).toEqual(["cyclic.md", "malformed.md"]);
    const loop: unknown[] = ["direct"];
    loop.push(loop);
    db.record({ notePath: "direct.md", axisKey: "subject", value: loop });
    expect(db.list({ notePath: "direct.md" })[0]?.value).toBe("direct");
    expect(() => db.reconcileObservedSnapshot([cyclic, cyclic], "duplicates")).toThrow("duplicate");
    expect(db.sourceSignature()).toBe("first");
  });

  it("preserves legacy canonical values and date values and handles nested lists safely", () => {
    const db = store();
    let deep: unknown = "survives";
    for (let i = 0; i < 20_000; i++) deep = [deep];
    db.record({ notePath: "deep.md", axisKey: "value", value: deep });
    db.replaceNote("note.md", { value: ["  MiXeD  ", new Date("2026-01-01T00:00:00Z"), null, { ignored: 1 }] });
    expect(db.list({ notePath: "note.md" }).map(item => item.value)).toEqual([new Date("2026-01-01T00:00:00Z"), "mixed"]);
    expect(db.matchObservedFields({ value: { from: "2025-12-31", to: "2026-01-02" } })).toEqual(["note.md"]);
    expect(db.list({ notePath: "deep.md" })[0]?.value).toBe("survives");
  });

  it("creates no query artifacts and refuses reconciliation into persistent caches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-observed-no-write-")); roots.push(root);
    const db = store();
    const before = await readdir(root);
    db.reconcileObservedSnapshot([source("a.md", "---\nsubject: science\n---\ntext")], "current");
    db.matchObservedFields({ subject: "science" });
    db.discoverObservedFields();
    expect(await readdir(root)).toEqual(before);
    const persistent = new AxisObservationStore(path.join(root, "cache.sqlite")); stores.push(persistent);
    expect(() => persistent.reconcileObservedSnapshot([], "x")).toThrow("in-memory");
  });
});

describe("bounded observed discovery", () => {
  it("counts documents before page limits, deduplicates members, and pages keys and typed values", () => {
    const db = store();
    db.replaceNote("a.md", { subject: ["science", "science", "math"], score: [1, "1"] });
    db.replaceNote("b.md", { subject: "science", score: 2 });
    db.record({ notePath: "a.md", axisKey: "subject", value: "science" });
    const first = db.discoverObservedFields({ limit: 1 });
    expect(first).toMatchObject({ kind: "keys", totalCount: 2, omittedCount: 0, keys: [{ key: "score", count: 2, valueCount: 3, valueTypes: ["number", "string"] }] });
    const next = db.discoverObservedFields({ limit: 1, cursor: first.cursor! });
    expect(next).toMatchObject({ cursor: null, keys: [{ key: "subject", count: 2, valueCount: 2 }] });
    const values = db.discoverObservedFields({ key: " SUBJECT ", limit: 1 });
    expect(values).toMatchObject({ kind: "values", key: "subject", totalCount: 2, values: [{ value: "math", count: 1 }] });
    const more = db.discoverObservedFields({ key: "subject", limit: 1, cursor: values.cursor! });
    expect(more).toMatchObject({ cursor: null, values: [{ value: "science", count: 2 }] });
    expect(db.discoverObservedFields({ key: "score" })).toMatchObject({ values: [{ value: 1, valueType: "number" }, { value: 2, valueType: "number" }, { value: "1", valueType: "string" }] });
  });

  it("scopes counts to both explicit fields and current lexical candidates", () => {
    const db = store();
    db.replaceNote("a.md", { subject: "science", mood: "good" });
    db.replaceNote("b.md", { subject: "science", mood: "great" });
    db.replaceNote("c.md", { subject: "math", mood: "good" });
    expect(db.discoverObservedFields({ key: "mood", fields: { subject: "science" }, candidatePaths: ["a.md", "c.md"] })).toMatchObject({ values: [{ value: "good", count: 1 }] });
    expect(db.discoverObservedFields({ candidatePaths: [] })).toMatchObject({ totalCount: 0, keys: [], cursor: null });
  });

  it("bounds byte payloads and reports skipped oversized entries without truncating exact values", () => {
    const db = store();
    const huge = "a".repeat(OBSERVED_DISCOVERY_MAX_VALUE_BYTES + 1);
    db.replaceNote("a.md", { subject: [huge, "science"], [huge]: "value" });
    expect(db.discoverObservedFields({ limit: 1 })).toMatchObject({ totalCount: 2, omittedCount: 1, keys: [{ key: "subject" }], cursor: null });
    expect(db.discoverObservedFields({ key: "subject", limit: 1 })).toMatchObject({ totalCount: 2, omittedCount: 1, cursor: null, values: [{ value: "science" }] });
    expect(db.matchObservedFields({ subject: huge })).toEqual(["a.md"]);
    expect(() => db.discoverObservedFields({ key: huge })).toThrow("512");
    expect(() => db.discoverObservedFields({ key: " " })).toThrow("non-empty");
    expect(Buffer.byteLength(JSON.stringify(db.discoverObservedFields({ key: "subject" })))).toBeLessThan(1000);
  });

  it("caps worst-case escaped UTF-8 pages and keeps exact scalar values", () => {
    const db = store();
    const values = Array.from({ length: 120 }, (_, index) => `${String(index).padStart(3, "0")}${"\u0000".repeat(509)}`);
    db.replaceNote("a.md", { control: values, unicode: ["한".repeat(170), "한".repeat(171)] });
    const page = db.discoverObservedFields({ key: "control", limit: 100 });
    expect(page.kind === "values" && page.values.length).toBeGreaterThan(0);
    expect(page.kind === "values" && page.values.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(32 * 1024);
    const found = page.kind === "values" ? page.values.map(value => value.value) : [];
    let cursor = page.cursor;
    while (cursor !== null) {
      const next = db.discoverObservedFields({ key: "control", limit: 100, cursor });
      expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(32 * 1024);
      if (next.kind === "values") {
        found.push(...next.values.map(value => value.value));
        for (const value of next.values) {
          expect(value.selection.exact.value).toBe(value.value);
          expect(db.matchObservedFields({ control: value.selection })).toEqual(["a.md"]);
          expect(value.count).toBe(1);
        }
      }
      cursor = next.cursor;
    }
    expect(found).toEqual(values);
    expect(page.kind === "values" && page.values[0]?.value).toBe(values[0]);
    expect(db.discoverObservedFields({ key: "unicode" })).toMatchObject({ totalCount: 2, omittedCount: 1 });
  });

  it("orders key/value pages deterministically regardless of insertion or candidate order", () => {
    const a = store(); const b = store();
    const first = source("a.md", "---\nzeta: last\nsubject: [z, a, 1, true]\n---\ntext");
    const second = source("b.md", "---\nalpha: first\nsubject: [1, a]\n---\ntext");
    a.reconcileObservedSnapshot([first, second], "same-source");
    b.reconcileObservedSnapshot([second, first], "same-source");
    expect(a.discoverObservedFields()).toEqual(b.discoverObservedFields());
    const page = a.discoverObservedFields({ key: "subject", candidatePaths: ["b.md", "a.md"], limit: 1 });
    expect(b.discoverObservedFields({ key: "subject", candidatePaths: ["a.md", "b.md"], limit: 1, cursor: page.cursor! })).toMatchObject({ values: [{ value: 1, valueType: "number" }] });
    expect(a.matchObservedFields({ subject: 1 })).toEqual(["a.md", "b.md"]);
    expect(a.matchObservedFields({ subject: "1" })).toEqual([]);
  });

  it("continues discovery across read-only sessions only when the captured source snapshot agrees", () => {
    const a = store();
    const b = store();
    const document = source("a.md", "---\nsubject: [one, two, three]\n---\ntext");
    a.reconcileObservedSnapshot([document], "same-byte-snapshot");
    b.reconcileObservedSnapshot([document], "same-byte-snapshot");
    const cursor = a.discoverObservedFields({ key: "subject", limit: 1 }).cursor!;
    expect(b.discoverObservedFields({ key: "subject", limit: 1, cursor })).toMatchObject({ values: [{ value: "three" }] });
    b.replaceNote("a.md", { subject: ["changed", "two"] });
    expect(() => b.discoverObservedFields({ key: "subject", limit: 1, cursor })).toThrow("cursor");
    b.record({ notePath: "stale.md", axisKey: "subject", value: "stale" });
    b.reconcileObservedSnapshot([document], "same-byte-snapshot");
    expect(b.discoverObservedFields({ key: "subject", limit: 1, cursor })).toMatchObject({ values: [{ value: "three" }] });
    expect(b.matchObservedFields({})).toEqual(["a.md"]);
  });

  it("rejects cursors from another snapshot, filter, key, or store", () => {
    const db = store();
    db.replaceNote("a.md", { subject: ["one", "two"], mood: "fine" });
    const cursor = db.discoverObservedFields({ limit: 1 }).cursor!;
    expect(cursor).toBeTypeOf("string");
    expect(() => db.discoverObservedFields({ cursor, key: "subject" })).toThrow("cursor");
    expect(() => db.discoverObservedFields({ cursor, fields: { mood: "fine" } })).toThrow("cursor");
    expect(() => store().discoverObservedFields({ cursor })).toThrow("cursor");
    expect(() => db.discoverObservedFields({ cursor: "junk" })).toThrow("cursor");
    expect(() => db.discoverObservedFields({ cursor: "x".repeat(8193) })).toThrow("cursor");
    db.replaceNote("b.md", { subject: "three" });
    expect(() => db.discoverObservedFields({ cursor })).toThrow("cursor");
  });

  it.each([0, -1, 101, 1.5, Number.NaN])("rejects invalid discovery limit %s", limit => {
    expect(() => store().discoverObservedFields({ limit })).toThrow("limit");
  });

  it("intersects 20k candidates with no bind-count ceiling and returns bounded discovery pages", () => {
    const db = store();
    const candidates = Array.from({ length: 20_000 }, (_, i) => `notes/${String(i).padStart(5, "0")}.md`);
    db.runInTransaction(() => {
      for (const [index, notePath] of candidates.entries()) db.replaceNote(notePath, { subject: index % 100 === 0 ? "rare" : "common", score: index, unique: `value-${index}` });
    });
    expect(db.matchObservedFields({ subject: "rare", score: { gte: 19_000 } }, candidates)).toHaveLength(10);
    const page = db.discoverObservedFields({ key: "unique", candidatePaths: candidates, limit: 100 });
    expect(page).toMatchObject({ totalCount: 20_000, omittedCount: 0 });
    expect(page.kind === "values" && page.values).toHaveLength(100);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(20_000);
  }, 30_000);
});
