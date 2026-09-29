import { describe, expect, it } from "vitest";

import { looseningChanges } from "../src/kernel/contract/loosening.js";
import { isSafeName } from "../src/kernel/contract/store.js";
import type { TemplatedContract } from "../src/kernel/contract/legacy.js";
import type { LegacyTemplateContract } from "../src/kernel/contract/types.js";
import { parseLiveTemplate } from "../src/kernel/write/live-templates.js";

/**
 * Pins that templates are never contract: a legacy template's identity, content or
 * scope never counts as a loosening change, so a later change to `looseningChanges`
 * cannot silently make templates part of the seal again.
 */

const HASH = `sha256:${"a".repeat(64)}` as `sha256:${string}`;
const MANUAL = "Templates/manual/meeting.template.md";
const AGENT = "Templates/agent/meeting.template.md";

function template(source: string, extra: Partial<LegacyTemplateContract> = {}): LegacyTemplateContract {
  return { source, sourceHash: HASH, requiredProperties: ["status"], narrowedRules: {}, requiredHeadings: ["Agenda"], ...extra };
}

const base = {
  folders: { Inbox: { meaning: "", searchExclude: false } },
  properties: { status: { meaning: "", type: "text", default: false, required: true, rules: [] } },
} as const satisfies Omit<TemplatedContract, "templates">;

function vault(templates: TemplatedContract["templates"]): TemplatedContract {
  return { ...base, templates };
}

describe("template identity under looseningChanges", () => {
  it("rekeying a legacy template is not a change: templates are not contract", () => {
    expect(looseningChanges(vault({ meeting: template(MANUAL) }), vault({ manual__meeting: template(MANUAL) }))).toEqual([]);
  });

  it("a scoped separator must survive the template-name check that the store applies", () => {
    expect(isSafeName("manual/meeting")).toBe(false);
    expect(isSafeName("manual__meeting")).toBe(true);
  });

  it("registering both scoped names in a never-sealed vault is an addition, not a change", () => {
    expect(looseningChanges(vault({}), vault({ agent__meeting: template(AGENT), manual__meeting: template(MANUAL) }))).toEqual([]);
  });
});

describe("what a submitted interpretation could try to widen", () => {
  it("omitting a sealed template's field or heading is not a change, because the judge never reads a template", () => {
    const stripped = template(MANUAL, { requiredProperties: [], requiredHeadings: [] });
    expect(looseningChanges(vault({ meeting: template(MANUAL) }), vault({ meeting: stripped }))).toEqual([]);
  });

  it("moving a legacy template's source is not a change, since search exclusion follows templateFolder", () => {
    expect(looseningChanges(vault({ meeting: template(MANUAL) }), vault({ meeting: template(AGENT) }))).toEqual([]);
  });

  it("sourceHash alone is invisible to the loosening check, so it gates freshness and not safety", () => {
    const rehashed = template(MANUAL, { sourceHash: `sha256:${"b".repeat(64)}` });
    expect(looseningChanges(vault({ meeting: template(MANUAL) }), vault({ meeting: rehashed }))).toEqual([]);
  });

  it("a new scoped template overlapping a sealed scoped folder is not a change, because the judge never selects a template", () => {
    const sealed = template(MANUAL, { applyFolder: "Inbox" });
    const added = template(AGENT, { applyFolder: "Inbox", requiredProperties: [], requiredHeadings: [] });
    expect(looseningChanges(vault({ meeting: sealed }), vault({ meeting: sealed, agent__meeting: added }))).toEqual([]);
  });

  it("a new unscoped permissive template is not a change either", () => {
    const sealed = template(MANUAL, { applyFolder: "Inbox" });
    const added = template(AGENT, { requiredProperties: [], requiredHeadings: [] });
    expect(looseningChanges(vault({ meeting: sealed }), vault({ meeting: sealed, agent__meeting: added }))).toEqual([]);
  });
});

describe("a template that is entirely a Templater JS block", () => {
  it("loads as a live template that scaffolds nothing, since OMS never runs its JS", () => {
    const template = parseLiveTemplate("T/js.template.md", [
      "<%*",
      'const yaml = ["---", "type: meeting", "---"].join("\\n");',
      "tR += `${yaml}\\n## Thinking\\n`;",
      "%>",
      "",
    ].join("\n"));
    expect(template).toMatchObject({ name: "js.template", source: "T/js.template.md", folder: null, fields: [], headings: [] });
  });
});
