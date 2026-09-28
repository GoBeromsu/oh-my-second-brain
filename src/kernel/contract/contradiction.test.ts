import { describe, expect, it } from "vitest";
import { contractContradictions } from "./contradiction.js";
import type { PropertyContract, Rule, TemplateContract, VaultContract } from "./types.js";

const HASH = `sha256:${"a".repeat(64)}`;

function property(rules: readonly Rule[], extra: Partial<PropertyContract> = {}): PropertyContract {
  return { meaning: "", type: "text", default: false, required: false, rules, ...extra };
}

function template(extra: Partial<TemplateContract> = {}): TemplateContract {
  return { source: "Templates/T.md", sourceHash: HASH, requiredProperties: [], narrowedRules: {}, requiredHeadings: [], ...extra };
}

function contract(properties: VaultContract["properties"], templates: VaultContract["templates"] = {}): VaultContract {
  return { folders: null, properties, templates };
}

describe("contractContradictions", () => {
  it("finds nothing in a consistent contract", () => {
    expect(contractContradictions(contract({
      tags: property([{ kind: "count", min: 1, max: 3 }], { type: "list" }),
      score: property([{ kind: "range", min: 1, max: 10 }], { type: "number" }),
      day: property([{ kind: "range", min: "2026-01-01", max: "2026-12-31" }], { type: "date" }),
      mixed: property([{ kind: "range", min: 1, max: "0" }]),
      status: property([{ kind: "allowed", values: ["open", "done"] }, { kind: "fixed", value: "open" }]),
      owner: property([{ kind: "fixed", value: "me" }]),
      lower: property([{ kind: "count", min: 2 }, { kind: "range", max: 3 }]),
    }, { T: template({ requiredProperties: ["status"] }) }))).toEqual([]);
  });

  it("reports every kind by field, sorted and without values", () => {
    const found = contractContradictions(contract({
      tags: property([{ kind: "count", min: 4, max: 2 }], { type: "list" }),
      score: property([{ kind: "range", min: 10, max: 1 }], { type: "number" }),
      day: property([{ kind: "range", min: "2027-01-01", max: "2026-01-01" }], { type: "date" }),
      empty: property([{ kind: "allowed", values: [] }]),
      status: property([{ kind: "allowed", values: ["open"] }, { kind: "fixed", value: "SECRET" }]),
    }, { Meeting: template({ requiredProperties: ["missing-one", "missing-two"] }) }));
    expect(found).toEqual([
      { field: "day", kind: "range-bounds" },
      { field: "empty", kind: "allowed-empty" },
      { field: "score", kind: "range-bounds" },
      { field: "status", kind: "fixed-not-allowed" },
      { field: "tags", kind: "count-bounds" },
      { field: "template:Meeting", kind: "required-unregistered" },
    ]);
    expect(JSON.stringify(found)).not.toContain("SECRET");
  });

  it("combines a template's narrowed rules with the base rules and dedupes the result", () => {
    const found = contractContradictions(contract({
      status: property([{ kind: "allowed", values: ["open", "done"] }]),
      count: property([{ kind: "range", min: 5, max: 1 }], { type: "number" }),
    }, {
      A: template({ narrowedRules: { status: [{ kind: "fixed", value: "archived" }], count: [] } }),
      B: template({ narrowedRules: { status: [{ kind: "fixed", value: "archived" }], free: [{ kind: "count", min: 3, max: 1 }] } }),
    }));
    expect(found).toEqual([
      { field: "count", kind: "range-bounds" },
      { field: "free", kind: "count-bounds" },
      { field: "status", kind: "fixed-not-allowed" },
    ]);
  });

  it("does not report required properties as unregistered while the property axis is open", () => {
    expect(contractContradictions(contract(null, { T: template({ requiredProperties: ["anything"], narrowedRules: { x: [{ kind: "allowed", values: [] }] } }) })))
      .toEqual([{ field: "x", kind: "allowed-empty" }]);
  });
});
