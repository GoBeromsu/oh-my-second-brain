import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assembleGraphOnlyEngine } from "./assemble.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function freshVault(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "oms-graph-only-"));
  tempDirs.push(dir);
  mkdirSync(path.join(dir, "notes"), { recursive: true });
  writeFileSync(
    path.join(dir, "notes", "alpha.md"),
    "---\nconcept: Project\nstatus: active\n---\nAlpha links [[beta]].\n",
  );
  writeFileSync(
    path.join(dir, "notes", "beta.md"),
    "---\nconcept: Reference\n---\nBeta note.\n",
  );
  return dir;
}

describe("assembleGraphOnlyEngine", () => {
  it("serves graph build + axis retrieval model-free (deferred provider/store)", async () => {
    const vault = freshVault();
    const engine = assembleGraphOnlyEngine({ vault });
    try {
      expect(engine.provider.model).toContain("deferred");

      const build = await engine.adapter.graphBuild({}, vault);
      expect(build.available).toBe(true);

      // concept axis: only alpha (concept: Project) matches; beta (Reference) does not.
      const axis = await engine.adapter.retrieveByAxis({ concept: "Project" });
      expect(Array.isArray(axis.hits)).toBe(true);
      expect(axis.hits.length).toBe(1);
    } finally {
      await engine.dispose();
    }
  });

  it("guards the semantic path: embed rejects, vault sync reports unavailable", async () => {
    const vault = freshVault();
    const engine = assembleGraphOnlyEngine({ vault });
    try {
      await expect(engine.provider.embed("x")).rejects.toThrow(/unavailable/i);
      const sync = await engine.syncVault();
      expect(sync.available).toBe(false);
    } finally {
      await engine.dispose();
    }
  });
});
