import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractTemplate } from "../src/kernel/contract/extract.js";
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
  it("omitting a sealed template's field or heading is caught whatever produced the interpretation", () => {
    const stripped = template(MANUAL, { requiredProperties: [], requiredHeadings: [] });
    expect(looseningChanges(vault({ meeting: template(MANUAL) }), vault({ meeting: stripped }))).toEqual([
      { field: "templates.meeting.requiredProperties.status", kind: "required-dropped" },
      { field: "templates.meeting.requiredHeadings.Agenda", kind: "heading-dropped" },
    ]);
  });

  it("sourceHash alone is invisible to the loosening check, so it gates freshness and not safety", () => {
    const rehashed = template(MANUAL, { sourceHash: `sha256:${"b".repeat(64)}` });
    expect(looseningChanges(vault({ meeting: template(MANUAL) }), vault({ meeting: rehashed }))).toEqual([]);
  });

  it("a new scoped template overlapping a sealed scoped folder is caught", () => {
    const sealed = template(MANUAL, { applyFolder: "Inbox" });
    const added = template(AGENT, { applyFolder: "Inbox", requiredProperties: [], requiredHeadings: [] });
    expect(looseningChanges(vault({ meeting: sealed }), vault({ meeting: sealed, agent__meeting: added }))).toEqual([
      { field: "templates.agent__meeting.applyFolder", kind: "apply-folder-overlap" },
    ]);
  });

  it("a new unscoped permissive template is not a change, because the judge only makes scoped templates candidates", () => {
    const sealed = template(MANUAL, { applyFolder: "Inbox" });
    const added = template(AGENT, { requiredProperties: [], requiredHeadings: [] });
    expect(looseningChanges(vault({ meeting: sealed }), vault({ meeting: sealed, agent__meeting: added }))).toEqual([]);
  });
});

describe("a template that is entirely a Templater JS block", () => {
  it("extracts as an empty interpretation rather than a refusal, so the interview asks nothing about it", async () => {
    const root = await mkdtemp(join(tmpdir(), "oms-interpretation-"));
    await mkdir(join(root, "T"), { recursive: true });
    await writeFile(join(root, "T/js.template.md"), [
      "<%*",
      'const yaml = ["---", "type: meeting", "---"].join("\\n");',
      "tR += `${yaml}\\n## Thinking\\n`;",
      "%>",
      "",
    ].join("\n"), "utf8");
    const result = await extractTemplate(root, "T/js.template.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.extraction).toMatchObject({ fields: [], headings: [] });
  });
});
