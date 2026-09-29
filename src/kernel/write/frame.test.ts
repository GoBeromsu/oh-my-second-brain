import { describe, expect, it } from "vitest";
import type { TemplatedContract } from "../contract/legacy.js";
import type { ContractView } from "../contract/types.js";
import { frameFor } from "./frame.js";

const CONTRACT: TemplatedContract = {
  folders: {
    Projects: { meaning: "project notes", searchExclude: false },
    "Projects/Archive": { meaning: "finished projects", searchExclude: false },
  },
  properties: {
    status: { meaning: "active or done", type: "text", default: false, required: false, rules: [{ kind: "allowed", values: ["active", "done", 3, true] }] },
    kind: { meaning: "the kind", type: "text", default: false, required: false, rules: [{ kind: "allowed", values: ["Projects"] }] },
    created: { meaning: "creation date", type: "date", default: true, required: false, rules: [] },
    owner: { meaning: "who owns it", type: "text", default: true, required: true, rules: [] },
    rating: { meaning: "score", type: "number", default: false, required: false, rules: [{ kind: "range", min: 1 }] },
  },
  templates: {
    project: {
      source: "Templates/project.md",
      sourceHash: `sha256:${"0".repeat(64)}`,
      meaning: "one project",
      requiredProperties: ["rating"],
      narrowedRules: { created: [{ kind: "fixed", value: "2026-01-01" }] },
      requiredHeadings: ["Goals"],
    },
    bare: { source: "Templates/bare.md", sourceHash: `sha256:${"0".repeat(64)}`, requiredProperties: [], narrowedRules: {}, requiredHeadings: [] },
  },
};
const SEALED: ContractView = { state: "sealed", contract: { folders: CONTRACT.folders, properties: CONTRACT.properties }, legacy: { templates: CONTRACT.templates } };

describe("frameFor", () => {
  it("returns an empty frame for an open or unreadable contract", () => {
    for (const view of [{ state: "open" }, { state: "unreadable", reason: "broken" }] as const) {
      const state = view.state;
      expect(frameFor(view, { folder: "Projects", template: "project" })).toEqual({
        contract: state, folder: null, properties: [], template: null, defaults: [],
      });
    }
  });

  it("redacts hidden allowed values and meanings but keeps public tokens and booleans", () => {
    const frame = frameFor(SEALED);
    const byName = Object.fromEntries(frame.properties.map(property => [property.name, property]));
    expect(byName["status"]).toEqual({
      name: "status", meaning: "[redacted] or [redacted]", type: "text", required: false, default: false,
      constrained: true, allowed: ["[redacted]", "[redacted]", "[redacted]", true],
    });
    expect(byName["kind"]?.allowed).toEqual(["Projects"]);
    expect(byName["rating"]).toMatchObject({ constrained: true, allowed: null });
    expect(byName["created"]).toMatchObject({ constrained: false, allowed: null });
    expect(JSON.stringify(frame)).not.toMatch(/active|"done"|2026-01-01/);
  });

  it("sorts properties and lists only optional defaults", () => {
    const frame = frameFor(SEALED);
    expect(frame.properties.map(property => property.name)).toEqual(["created", "kind", "owner", "rating", "status"]);
    expect(frame.defaults).toEqual(["created"]);
  });

  it("picks the nearest registered folder and none at the vault root or outside", () => {
    expect(frameFor(SEALED, { folder: "Projects/Archive/2026" }).folder).toEqual({ path: "Projects/Archive", meaning: "finished projects" });
    expect(frameFor(SEALED, { folder: "Projects/Other" }).folder).toEqual({ path: "Projects", meaning: "project notes" });
    expect(frameFor(SEALED, { folder: "./Projects/" }).folder).toEqual({ path: "Projects", meaning: "project notes" });
    expect(frameFor(SEALED, { folder: "Loose" }).folder).toBeNull();
    expect(frameFor(SEALED, {}).folder).toBeNull();
    expect(frameFor({ state: "sealed", contract: { ...CONTRACT, folders: null } }, { folder: "Projects" }).folder).toBeNull();
  });

  it("describes the chosen template as a scaffold, while properties come from the property contract only", () => {
    const frame = frameFor(SEALED, { template: "project" });
    expect(frame.template).toEqual({ name: "project", meaning: "one project", requiredProperties: ["rating"], requiredHeadings: ["Goals"] });
    expect(frame.properties).toEqual(frameFor(SEALED, {}).properties);
    const byName = Object.fromEntries(frame.properties.map(property => [property.name, property]));
    expect(byName["rating"]?.required).toBe(false);
    expect(byName["created"]?.constrained).toBe(false);
    expect(frame.defaults).toEqual(["created"]);
  });

  it("reports a template without meaning as null and ignores an unknown template", () => {
    expect(frameFor(SEALED, { template: "bare" }).template).toEqual({ name: "bare", meaning: null, requiredProperties: [], requiredHeadings: [] });
    expect(frameFor(SEALED, { template: "missing" }).template).toBeNull();
    expect(frameFor(SEALED, { template: "toString" }).template).toBeNull();
  });

  it("tolerates a contract without properties", () => {
    const frame = frameFor({ state: "sealed", contract: { ...CONTRACT, properties: null } });
    expect(frame.properties).toEqual([]);
    expect(frame.defaults).toEqual([]);
  });
});
