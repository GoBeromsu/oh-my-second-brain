import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectDrift, templateDrift } from "./drift.js";
import { extractTemplate } from "./extract.js";
import type { PublicTemplate } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-contract-drift-"));
  roots.push(root);
  await mkdir(join(root, "T"));
  return root;
}

async function template(root: string, id: string): Promise<PublicTemplate> {
  const extraction = await extractTemplate(root, id);
  if (!extraction.ok) throw new Error("extraction failed");
  return { id, name: "A", applyFolder: null, fields: [], requiredHeadings: [], sourceHash: extraction.extraction.sourceHash, sealId: "00000000-0000-4000-8000-000000000001" };
}

describe("templateDrift", () => {
  it("is active until the source bytes change", async () => {
    const root = await vault();
    await writeFile(join(root, "T/A.md"), "# A\n");
    const sealed = await template(root, "T/A.md");
    expect(await templateDrift(root, sealed)).toBe("active");
    await writeFile(join(root, "T/A.md"), "# A\n\nmore\n");
    expect(await templateDrift(root, sealed)).toBe("drift");
  });

  it("is missing when the source is gone and drift when it becomes unsafe", async () => {
    const root = await vault();
    await writeFile(join(root, "T/A.md"), "# A\n");
    const sealed = await template(root, "T/A.md");
    await rm(join(root, "T/A.md"));
    expect(await templateDrift(root, sealed)).toBe("missing");
    await writeFile(join(root, "T/B.md"), "# A\n");
    await symlink(join(root, "T/B.md"), join(root, "T/A.md"));
    expect(await templateDrift(root, sealed)).toBe("drift");
  });

  it("maps every manifest template", async () => {
    const root = await vault();
    await writeFile(join(root, "T/A.md"), "# A\n");
    const sealed = await template(root, "T/A.md");
    const states = await detectDrift(root, { version: 1, common: null, templates: [sealed, { ...sealed, id: "T/Gone.md" }] });
    expect([...states]).toEqual([["T/A.md", "active"], ["T/Gone.md", "missing"]]);
  });
});
