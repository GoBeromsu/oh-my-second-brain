import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { decideSetup, inspectSetup } from "./service.js";

let vault: string | undefined;
afterEach(async () => { if (vault !== undefined) await rm(vault, { recursive: true, force: true }); vault = undefined; });

describe("template-first setup service", () => {
  it("discovers an existing custom template folder without writing vault state", async () => {
    vault = await mkdtemp(path.join(tmpdir(), "oms-template-setup-"));
    await mkdir(path.join(vault, "My Templates", "nested"), { recursive: true });
    await writeFile(path.join(vault, "My Templates", "nested", "reading.md"), "---\ntemplate: reading\n---\n", "utf8");

    const state = await inspectSetup({ vault, templateFolder: "My Templates" });
    const decision = await decideSetup(state, { templateFolder: "My Templates" });

    expect(decision.document.questionnaire.templateFolder).toBe("My Templates");
    expect(decision.proposal.managedSourcePaths).toEqual(["My Templates/nested/reading.md"]);
    expect(existsSync(path.join(vault, ".oms"))).toBe(false);
  });
});
