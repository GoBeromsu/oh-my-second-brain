import { describe, expect, it } from "vitest";
import { digestBytes } from "../conventions/canonical.js";
import { legacyTemplatesOf, templatedContract } from "./legacy.js";
import type { LegacyTemplateContract } from "./types.js";

const MEETING: LegacyTemplateContract = {
  source: "Templates/Meeting.md", sourceHash: digestBytes("x"),
  requiredProperties: [], narrowedRules: {}, requiredHeadings: ["Agenda"],
};
const CONTRACT = { folders: null, properties: {} };

describe("legacy template projection", () => {
  it("is empty for an open or unreadable view", () => {
    expect(legacyTemplatesOf({ state: "open" })).toEqual({});
    expect(legacyTemplatesOf({ state: "unreadable", reason: "broken" })).toEqual({});
  });

  it("is empty for a version 3 head, which carries no legacy projection", () => {
    const view = { state: "sealed", contract: CONTRACT } as const;
    expect(legacyTemplatesOf(view)).toEqual({});
    expect(templatedContract(view)).toEqual({ ...CONTRACT, templates: {} });
  });

  it("joins an older generation's templates back onto its contract", () => {
    const view = { state: "sealed", contract: CONTRACT, legacy: { templates: { Meeting: MEETING } } } as const;
    expect(legacyTemplatesOf(view)).toEqual({ Meeting: MEETING });
    expect(templatedContract(view)).toEqual({ ...CONTRACT, templates: { Meeting: MEETING } });
    expect(view.contract).not.toHaveProperty("templates");
  });
});
