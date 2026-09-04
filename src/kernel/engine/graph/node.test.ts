import { describe, expect, it } from "vitest";
import { filterNodesByAxis, filterNodesByQueryAxes, queryFacets, searchScore } from "./node.js";
import type { EngineGraphNode } from "./node.js";

const nodes: EngineGraphNode[] = [
  { path: "notes/a.md", template: "note", folder: "notes", axes: { status: ["open"], rating: [5] }, wikilinks: ["notes/b.md"], bodyPreview: "", searchTerms: new Set() },
  { path: "projects/b.md", template: "project", folder: "projects", axes: { status: ["closed"] }, wikilinks: [], bodyPreview: "", searchTerms: new Set() },
];

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

  it("ranks greater query coverage above lower coverage regardless of path order", () => {
    const higherCoverage: EngineGraphNode = { path: "notes/zulu.md", template: "note", folder: "notes", axes: {}, wikilinks: [], bodyPreview: "", searchTerms: new Set(["alpha", "beta"]) };
    const lowerCoverage: EngineGraphNode = { path: "notes/alpha.md", template: "note", folder: "notes", axes: {}, wikilinks: [], bodyPreview: "", searchTerms: new Set(["alpha"]) };

    expect(searchScore(higherCoverage, "alpha beta")).toBeGreaterThan(searchScore(lowerCoverage, "alpha beta"));
  });

  it("uses title coverage to break equal-coverage ties before path order", () => {
    const titleMatch: EngineGraphNode = { path: "notes/alpha.md", template: "note", folder: "notes", axes: {}, wikilinks: [], bodyPreview: "", searchTerms: new Set(["alpha"]) };
    const pathFirst: EngineGraphNode = { path: "notes/aaa.md", template: "note", folder: "notes", axes: {}, wikilinks: [], bodyPreview: "", searchTerms: new Set(["alpha"]) };

    const ranked = [pathFirst, titleMatch].sort((left, right) =>
      searchScore(right, "alpha") - searchScore(left, "alpha") || left.path.localeCompare(right.path),
    );

    expect(ranked.map(node => node.path)).toEqual(["notes/alpha.md", "notes/aaa.md"]);
  });

  it("scores nodes with no matching query terms as zero", () => {
    const node: EngineGraphNode = { path: "notes/alpha.md", template: "note", folder: "notes", axes: {}, wikilinks: [], bodyPreview: "", searchTerms: new Set(["alpha"]) };

    expect(searchScore(node, "beta")).toBe(0);
  });
});
