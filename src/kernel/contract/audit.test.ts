import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTruthTableRow, type TruthTableFixture } from "../../../test/fixtures/contract-truth-table.js";
import { auditVault } from "./audit.js";
import type { VaultContract } from "./types.js";

const SECRET = "zeta-secret-value";
const CONTRACT: VaultContract = {
  folders: { Projects: { meaning: "project notes", searchExclude: false }, Templates: { meaning: "sources", searchExclude: true } },
  properties: {
    status: { meaning: "state", type: "text", default: false, required: true, rules: [{ kind: "allowed", values: [SECRET] }] },
  },
  templates: {
    project: { source: "Templates/project.md", sourceHash: `sha256:${"0".repeat(64)}`, applyFolder: "Projects", requiredProperties: ["status"], narrowedRules: {}, requiredHeadings: [] },
  },
};

const fixtures: TruthTableFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
});

async function sealedVault(notes: Record<string, string>): Promise<TruthTableFixture> {
  const fixture = await buildTruthTableRow("sealed", CONTRACT);
  fixtures.push(fixture);
  for (const [notePath, content] of Object.entries(notes)) {
    await mkdir(join(fixture.vault, notePath, ".."), { recursive: true });
    await writeFile(join(fixture.vault, notePath), content);
  }
  return fixture;
}

describe("auditVault", () => {
  it("re-judges every note and aggregates {path, field, kind} without values, ids or store paths", async () => {
    const fixture = await sealedVault({
      "Projects/good.md": `---\nstatus: ${SECRET}\n---\nBody\n`,
      "Projects/bad.md": "---\nstatus: other\nextra: 1\n---\nBody\n",
      "Loose/stray.md": `---\nstatus: ${SECRET}\n---\n`,
      "Projects/broken.md": "---\nstatus: [\n---\n",
      "Templates/project.md": "---\nstatus: {{status}}\n---\n",
    });
    const audit = await auditVault(fixture.vault, {}, fixture.root);
    expect(audit).toEqual({
      contract: "sealed",
      scannedNotes: 4,
      clean: false,
      violations: [
        { path: "Loose/stray.md", field: "path", kind: "unregistered-folder" },
        { path: "Projects/bad.md", field: "extra", kind: "unknown-property" },
        { path: "Projects/bad.md", field: "status", kind: "not-allowed" },
        { path: "Projects/broken.md", field: "content", kind: "yaml-syntax" },
      ],
    });
    const text = JSON.stringify(audit);
    for (const leak of [SECRET, fixture.vaultId, fixture.root]) expect(text).not.toContain(leak);
  });

  it("limits the scan to one top-level folder", async () => {
    const fixture = await sealedVault({
      "Projects/good.md": `---\nstatus: ${SECRET}\n---\n`,
      "Loose/stray.md": "x\n",
    });
    expect(await auditVault(fixture.vault, { folder: "Projects" }, fixture.root)).toEqual({ contract: "sealed", scannedNotes: 1, clean: true, violations: [] });
  });

  it("reports an open vault clean and an unreadable contract once, not per note", async () => {
    const open = await buildTruthTableRow("never-sealed");
    fixtures.push(open);
    await writeFile(join(open.vault, "a.md"), "---\nanything: 1\n---\n");
    expect(await auditVault(open.vault, {}, open.root)).toEqual({ contract: "none", scannedNotes: 1, clean: true, violations: [] });

    const unreadable = await buildTruthTableRow("index-without-store", CONTRACT);
    fixtures.push(unreadable);
    await writeFile(join(unreadable.vault, "a.md"), "x\n");
    expect(await auditVault(unreadable.vault, {}, unreadable.root)).toEqual({ contract: "unreadable", scannedNotes: 1, clean: false, violations: [] });
  });
});
