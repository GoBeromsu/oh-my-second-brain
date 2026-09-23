import { describe, expect, it } from "vitest";
import { filterNodesByAxis, filterNodesByQueryAxes, queryFacets, searchScore, toAxisScalars } from "./node.js";
import type { EngineGraphNode } from "./node.js";

function graphNode(overrides: Partial<EngineGraphNode> & Pick<EngineGraphNode, "path" | "folder">): EngineGraphNode {
  return {
    template: "note",
    binding: "template",
    diagnostics: [],
    axes: {},
    wikilinks: [],
    bodyPreview: "",
    searchTerms: new Set<string>(),
    ...overrides,
  };
}

const note = graphNode({
  path: "notes/a.md",
  folder: "notes",
  template: "note",
  axes: { status: ["open"], rating: [5] },
  wikilinks: ["notes/b.md"],
});
const project = graphNode({
  path: "projects/b.md",
  folder: "projects",
  template: "project",
  axes: { status: ["closed"] },
});
const unbound = graphNode({
  path: "notes/plain.md",
  folder: "notes",
  template: null,
  binding: "default",
  axes: { title: ["Hello"] },
  wikilinks: ["notes/a.md"],
});
const nodes = [note, project];

describe("template graph node axes", () => {
  it("filters by template, declared fields, and global folder/link axes", () => {
    expect(filterNodesByQueryAxes(nodes, { template: "note", field: { status: "open" }, folder: "notes", link: "b" }).map(node => node.path)).toEqual(["notes/a.md"]);
    expect(filterNodesByAxis(nodes, { template: "project", property: "status", value: "closed" }).map(node => node.path)).toEqual(["projects/b.md"]);
  });

  it("emits deterministic template, field, folder, and link facets", () => {
    expect(queryFacets(nodes)).toEqual([
      { axis: "field", key: "rating", value: "5", count: 1 },
      { axis: "field", key: "status", value: "closed", count: 1 },
      { axis: "field", key: "status", value: "open", count: 1 },
      { axis: "folder", value: "notes", count: 1 },
      { axis: "folder", value: "projects", count: 1 },
      { axis: "link", value: "notes/b.md", count: 1 },
      { axis: "template", value: "note", count: 1 },
      { axis: "template", value: "project", count: 1 },
    ]);
  });

  it("fails loudly for an unknown public axis", () => {
    expect(() => filterNodesByQueryAxes(nodes, { invalid: "value" } as never)).toThrow(/Unknown query axis/);
  });

  it("omits null templates from facets and template filters without inventing an id", () => {
    expect(queryFacets([note, unbound]).filter(facet => facet.axis === "template")).toEqual([
      { axis: "template", value: "note", count: 1 },
    ]);
    expect(queryFacets([unbound]).some(facet => facet.axis === "template" || facet.value === "default" || facet.value === "unresolved")).toBe(false);
    expect(filterNodesByQueryAxes([note, unbound], { template: "note" }).map(node => node.path)).toEqual(["notes/a.md"]);
    expect(filterNodesByQueryAxes([unbound], { folder: "notes", link: "a" }).map(node => node.path)).toEqual(["notes/plain.md"]);
    expect(filterNodesByAxis([unbound], { template: "note" })).toEqual([]);
    expect(filterNodesByAxis([unbound], {}).map(node => node.path)).toEqual(["notes/plain.md"]);
  });

  it("ranks greater query coverage above lower coverage regardless of path order", () => {
    const higherCoverage = graphNode({ path: "notes/zulu.md", folder: "notes", searchTerms: new Set(["alpha", "beta"]) });
    const lowerCoverage = graphNode({ path: "notes/alpha.md", folder: "notes", searchTerms: new Set(["alpha"]) });

    expect(searchScore(higherCoverage, "alpha beta")).toBeGreaterThan(searchScore(lowerCoverage, "alpha beta"));
  });

  it("uses title coverage to break equal-coverage ties before path order", () => {
    const titleMatch = graphNode({ path: "notes/alpha.md", folder: "notes", searchTerms: new Set(["alpha"]) });
    const pathFirst = graphNode({ path: "notes/aaa.md", folder: "notes", searchTerms: new Set(["alpha"]) });

    const ranked = [pathFirst, titleMatch].sort((left, right) =>
      searchScore(right, "alpha") - searchScore(left, "alpha") || left.path.localeCompare(right.path),
    );

    expect(ranked.map(node => node.path)).toEqual(["notes/alpha.md", "notes/aaa.md"]);
  });

  it("scores nodes with no matching query terms as zero", () => {
    const node = graphNode({ path: "notes/alpha.md", folder: "notes", searchTerms: new Set(["alpha"]) });

    expect(searchScore(node, "beta")).toBe(0);
  });

  it("cuts cyclic arrays and keeps finite scalars beside unsupported values", () => {
    const cycle: unknown[] = ["open"];
    cycle.push(cycle);
    expect(toAxisScalars(cycle)).toEqual({ values: ["open"], supported: false });
    const only: unknown[] = [];
    only.push(only);
    expect(toAxisScalars(only)).toEqual({ values: [], supported: false });
    const converted = toAxisScalars([1.5, Number.NaN, Number.POSITIVE_INFINITY, -0, 1e30, { nested: true }, true, null]);
    expect(converted.supported).toBe(false);
    expect(converted.values.map(value => typeof value === "number" && Object.is(value, -0) ? "-0" : value)).toEqual([1.5, "-0", 1e30, true]);
    expect(toAxisScalars(null)).toEqual({ values: [], supported: true });
    expect(toAxisScalars(["  kept  ", "   "])).toEqual({ values: ["kept"], supported: true });
    const shared = ["open"];
    expect(toAxisScalars([[shared], shared])).toEqual({ values: ["open", "open"], supported: true });
    const nested: unknown[] = [1.5, Number.NaN];
    expect(toAxisScalars([nested, 2])).toEqual({ values: [1.5, 2], supported: false });
  });

  it("matches signed zero, decimals, and large finite field values", () => {
    const decimal = graphNode({ path: "notes/decimal.md", folder: "notes", axes: { rating: [1.5, 1e30, -0] } });
    expect(filterNodesByQueryAxes([decimal], { field: { rating: 1.5 } }).map(node => node.path)).toEqual(["notes/decimal.md"]);
    expect(filterNodesByQueryAxes([decimal], { field: { rating: 1e30 } }).map(node => node.path)).toEqual(["notes/decimal.md"]);
    expect(filterNodesByQueryAxes([decimal], { field: { rating: 0 } }).map(node => node.path)).toEqual(["notes/decimal.md"]);
    expect(filterNodesByQueryAxes([decimal], { field: { rating: -0 } }).map(node => node.path)).toEqual(["notes/decimal.md"]);
  });
});
