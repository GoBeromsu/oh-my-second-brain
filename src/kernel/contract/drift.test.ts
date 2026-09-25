import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectDrift, templateDrift } from "./drift.js";
import { extractTemplate } from "./extract.js";
import type { TemplateContract } from "./types.js";

let vault: string;

beforeEach(async () => {
  vault = await realpath(await mkdtemp(join(tmpdir(), "oms-drift-")));
  await mkdir(join(vault, "Templates"));
  await writeFile(join(vault, "Templates/Meeting.md"), "---\nstatus: open\n---\n## Agenda\n");
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

async function sealedTemplate(): Promise<TemplateContract> {
  const result = await extractTemplate(vault, "Templates/Meeting.md");
  if (!result.ok) throw new Error("extraction failed");
  return { source: "Templates/Meeting.md", sourceHash: result.extraction.sourceHash, requiredProperties: [], narrowedRules: {}, requiredHeadings: [] };
}

describe("template drift", () => {
  it("is active when the source is unchanged", async () => {
    expect(await templateDrift(vault, await sealedTemplate())).toBe("active");
  });

  it("is drift when the source changed", async () => {
    const template = await sealedTemplate();
    await writeFile(join(vault, "Templates/Meeting.md"), "---\nstatus: closed\n---\n## Agenda\n");
    expect(await templateDrift(vault, template)).toBe("drift");
  });

  it("is missing when the source is gone", async () => {
    const template = await sealedTemplate();
    await rm(join(vault, "Templates/Meeting.md"));
    expect(await templateDrift(vault, template)).toBe("missing");
  });

  it("reports every template by name", async () => {
    const active = await sealedTemplate();
    const gone: TemplateContract = { ...active, source: "Templates/Gone.md" };
    const states = await detectDrift(vault, { folders: null, properties: null, templates: { Meeting: active, Gone: gone } });
    expect(Object.fromEntries(states)).toEqual({ Meeting: "active", Gone: "missing" });
  });
});
