import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { enumerateTemplateSources } from "../src/kernel/contract/interpretation.js";
import { looseningChanges } from "../src/kernel/contract/loosening.js";
import { isSafeName } from "../src/kernel/contract/store.js";
import type { TemplateContract, VaultContract } from "../src/kernel/contract/types.js";

/**
 * Pins the classifications the interpretation-as-input design depends on
 * (docs/research/contract-interpretation-as-input.md). These are not new
 * behaviour: they fix observations that the design argument cites, so a later
 * change to `looseningChanges` or to template identity cannot silently
 * invalidate the argument.
 */

const HASH = `sha256:${"a".repeat(64)}` as `sha256:${string}`;
const MANUAL = "Templates/manual/meeting.template.md";
const AGENT = "Templates/agent/meeting.template.md";

function template(source: string, extra: Partial<TemplateContract> = {}): TemplateContract {
  return { source, sourceHash: HASH, requiredProperties: ["status"], narrowedRules: {}, requiredHeadings: ["Agenda"], ...extra };
}

const base = {
  folders: { Inbox: { meaning: "", searchExclude: false } },
  properties: { status: { meaning: "", type: "text", default: false, required: true, rules: [] } },
} as const satisfies Omit<VaultContract, "templates">;

function vault(templates: VaultContract["templates"]): VaultContract {
  return { ...base, templates };
}

describe("template identity under looseningChanges", () => {
  it("rekeying a sealed template to a scoped name reads as a removal, so a sealed vault cannot reseal without a terminal", () => {
    const changes = looseningChanges(vault({ meeting: template(MANUAL) }), vault({ manual__meeting: template(MANUAL) }));
    expect(changes).toEqual([{ field: "templates.meeting", kind: "removed" }]);
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

  it("moving a sealed template's source is caught, since search exclusion is built from sealed sources", () => {
    expect(looseningChanges(vault({ meeting: template(MANUAL) }), vault({ meeting: template(AGENT) }))).toEqual([
      { field: "templates.meeting.source", kind: "removed" },
    ]);
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
  it("is enumerated as a source like any other, since OMS does not read it", async () => {
    const root = await mkdtemp(join(tmpdir(), "oms-interpretation-"));
    await mkdir(join(root, "T"), { recursive: true });
    await writeFile(join(root, "T/js.template.md"), [
      "<%*",
      'const yaml = ["---", "type: meeting", "---"].join("\\n");',
      "tR += `${yaml}\\n## Thinking\\n`;",
      "%>",
      "",
    ].join("\n"), "utf8");
    const result = await enumerateTemplateSources(root, { path: "T", kind: "folder" });
    // Nothing here is parseable frontmatter, and that is no longer OMS's problem: it
    // reports the source and its digest, and the agent interprets the JS.
    expect(result).toMatchObject({ ok: true, sources: [{ path: "T/js.template.md" }] });
  });
});
