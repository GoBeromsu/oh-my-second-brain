import { describe, expect, it } from "vitest";
import { AxisObservationStore } from "./store.js";
import type { ObservedFieldFilters } from "./observed-query.js";
import { filterNodesByQueryAxes } from "../graph/node.js";

const ISO = "2026-01-01T00:00:00.000Z";
const TIME = 1767225600000;

describe("typed observed facet selection", () => {
  it("blindly round-trips each facet selection across Date/string/timestamp/boolean scalar and list notes", () => {
    const db = new AxisObservationStore(":memory:");
    try {
      db.replaceNote("date-scalar.md", { when: new Date(ISO) });
      db.replaceNote("date-list.md", { when: [new Date(ISO), new Date(ISO)] });
      db.replaceNote("string-scalar.md", { when: ISO });
      db.replaceNote("string-list.md", { when: [ISO, ISO] });
      db.replaceNote("number-scalar.md", { when: TIME });
      db.replaceNote("number-list.md", { when: [TIME, TIME] });
      db.replaceNote("boolean-scalar.md", { when: true });
      db.replaceNote("boolean-list.md", { when: [true, true] });
      db.replaceNote("boolean-string.md", { when: "true" });
      db.replaceNote("mixed-list.md", { when: [new Date(ISO), ISO, TIME, true, "true"] });
      const page = db.discoverObservedFields({ key: "when" });
      expect(page.kind).toBe("values");
      if (page.kind !== "values") throw new Error("Expected values");
      expect(page.values).toHaveLength(5);
      for (const facet of page.values) {
        expect(facet).toHaveProperty("selection");
        const paths = [...new Set(db.list({ axisKey: "when" }).filter(row => row.valueType === facet.valueType && row.normalizedValue === facet.normalizedValue).map(row => row.notePath))].sort();
        expect(db.matchObservedFields({ when: facet.selection })).toEqual(paths);
        const transported = JSON.parse(JSON.stringify(facet.selection)) as typeof facet.selection;
        expect(transported).toEqual(facet.selection);
        expect(db.matchObservedFields({ when: transported })).toEqual(paths);
        expect(paths.length).toBe(facet.count);
      }
      // Legacy membership and declared comparison retain their date coercion.
      expect(db.matchObservedFields({ when: ISO })).toHaveLength(7);
      expect(filterNodesByQueryAxes([{ path: "declared.md", template: null, binding: "default", diagnostics: [], folder: "", axes: { when: [ISO] }, wikilinks: [], bodyPreview: "", searchTerms: new Set() }], { field: { when: TIME } })).toHaveLength(1);
    } finally { db.close(); }
  });

  it.each([-8_640_000_000_000_000, -62_167_219_200_000, 0, 8_640_000_000_000_000])("accepts its own finite date selector across JSON at timestamp %s", timestamp => {
    const db = new AxisObservationStore(":memory:");
    try {
      db.replaceNote("date.md", { when: new Date(timestamp) });
      const page = db.discoverObservedFields({ key: "when" });
      if (page.kind !== "values") throw new Error("Expected date value");
      const facet = page.values[0]!;
      expect(facet.value).toBeInstanceOf(Date);
      expect(facet.selection.exact.value).toBe(new Date(timestamp).toISOString());
      expect(db.matchObservedFields({ when: JSON.parse(JSON.stringify(facet.selection)) as typeof facet.selection })).toEqual(["date.md"]);
    } finally { db.close(); }
  });

  it.each([
    null, [], {}, { valueType: "unknown", value: "x" }, { valueType: "string", value: 1 },
    { valueType: "number", value: "1" }, { valueType: "boolean", value: "true" },
    { valueType: "string", value: " " }, { valueType: "number", value: Number.NaN },
    { valueType: "number", value: Number.POSITIVE_INFINITY }, { valueType: "string", value: ["x"] },
    { valueType: "date", value: new Date(ISO) }, { valueType: "date", value: "2026-02-31T00:00:00.000Z" },
    { valueType: "date", value: "2026-02-29T00:00:00.000Z" }, { valueType: "date", value: "not a date" },
    { valueType: "date", value: "2026-01-01" }, { valueType: "date", value: "2026-01-01T00:00:00Z" },
    { valueType: "date", value: "2026-01-01t00:00:00.000z" }, { valueType: "date", value: TIME },
    { valueType: "string", value: "x", extra: true }, { valueType: "string" }, { value: "x" },
  ])("rejects malformed or coercing exact selection %j", exact => {
    const db = new AxisObservationStore(":memory:");
    try { expect(() => db.matchObservedFields({ when: { exact } } as ObservedFieldFilters)).toThrow(); }
    finally { db.close(); }
  });

  it("binds exact values as data and accepts canonical leap-date facets unchanged", () => {
    const db = new AxisObservationStore(":memory:");
    try {
      const value = "'); DROP TABLE axis_observation; --";
      db.replaceNote("value.md", { key: value, when: new Date("2024-02-29T00:00:00.000Z") });
      expect(db.matchObservedFields({ key: { exact: { valueType: "string", value } } })).toEqual(["value.md"]);
      expect(db.matchObservedFields({ when: { exact: { valueType: "date", value: "2024-02-29T00:00:00.000Z" } } })).toEqual(["value.md"]);
      expect(db.count()).toBe(2);
    } finally { db.close(); }
  });

  it("reproduces a scoped facet only when the existing same-key predicate is preserved", () => {
    const db = new AxisObservationStore(":memory:");
    try {
      db.replaceNote("a.md", { score: [1, 20] });
      db.replaceNote("b.md", { score: [1] });
      const range = { gte: 10 };
      const page = db.discoverObservedFields({ key: "score", fields: { score: range } });
      if (page.kind !== "values") throw new Error("Expected values");
      const facet = page.values.find(value => value.value === 1)!;
      expect(facet.count).toBe(1);
      expect(db.matchObservedFields({ score: { ...range, ...facet.selection } })).toEqual(["a.md"]);
      // Replacing the range deliberately changes the candidate scope.
      expect(db.matchObservedFields({ score: facet.selection })).toEqual(["a.md", "b.md"]);
    } finally { db.close(); }
  });
});
