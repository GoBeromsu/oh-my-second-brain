import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const checker = resolve(repositoryRoot, "scripts/check-doc-mapping.mjs");
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function runChecker(root: string): { status: number; output: string } {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [checker, root], { encoding: "utf8", stdio: "pipe" }),
    };
  } catch (error) {
    const result = error as { status: number; stderr: string; stdout: string };
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }
}

describe("documentation mapping checker", () => {
  it("reports a deliberately broken relative reference", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "oms-doc-mapping-"));
    fixtures.push(fixture);
    writeFileSync(resolve(fixture, "CONTRIBUTING.md"), "[broken](./missing.md)\n");

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("CONTRIBUTING.md:1: missing reference ./missing.md");
  });

  it("accepts the repository documentation tree", () => {
    const result = runChecker(repositoryRoot);

    expect(result.status).toBe(0);
    expect(result.output).toBe("");
  });
});
