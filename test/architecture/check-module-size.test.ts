import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  MODULE_SIZE_POLICY_ID,
  RESEED_SLACK,
  SOFT_CAP,
  assertPolicyLiterals,
  ceilingFor,
  countLines,
  evaluate,
} from "../../scripts/check-module-size.mjs";
import { absolute } from "./repo-root.js";

/**
 * The ratchet is only worth having if it rejects concrete bad inputs. Each case
 * below is a specific violation, not an existence check on the script.
 */
describe("module-size ratchet", () => {
  it("pins the policy constants", () => {
    expect(MODULE_SIZE_POLICY_ID).toBe("oms.module-size.v1");
    expect(SOFT_CAP).toBe(2000);
    expect(RESEED_SLACK).toBe(200);
  });

  it("rejects a file that exceeds the soft cap", () => {
    const violations = evaluate({
      files: ["src/kernel/huge.ts"],
      currentLines: { "src/kernel/huge.ts": SOFT_CAP + 1 },
      baselineLines: null,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("over-ceiling");
    expect(violations[0]?.ceiling).toBe(SOFT_CAP);
  });

  it("accepts a file exactly at the soft cap", () => {
    expect(
      evaluate({
        files: ["src/kernel/exact.ts"],
        currentLines: { "src/kernel/exact.ts": SOFT_CAP },
        baselineLines: null,
      }),
    ).toEqual([]);
  });

  it("holds every file to the soft cap because the grandfathered set is empty", () => {
    expect(ceilingFor("src/capture/safe.ts")).toBe(SOFT_CAP);
    expect(ceilingFor("anything/at/all.ts")).toBe(SOFT_CAP);
  });

  it("rejects a policy constant that is not a literal", () => {
    const tampered = [
      'export const MODULE_SIZE_POLICY_ID = "oms.module-size.v1";',
      'export const SOURCE_ROOT = "src";',
      'export const SOURCE_EXTENSIONS = [".ts"];',
      "export const SOFT_CAP = Number(process.env.CAP ?? 2000);",
      "export const RESEED_SLACK = 200;",
    ].join("\n");

    expect(() => assertPolicyLiterals(tampered)).toThrow(/SOFT_CAP is not a literal assignment/);
  });

  it("rejects a swapped policy sentinel", () => {
    const tampered = [
      'export const MODULE_SIZE_POLICY_ID = "oms.module-size.v0-relaxed";',
      'export const SOURCE_ROOT = "src";',
      'export const SOURCE_EXTENSIONS = [".ts"];',
      "export const SOFT_CAP = 2000;",
      "export const RESEED_SLACK = 200;",
    ].join("\n");

    expect(() => assertPolicyLiterals(tampered)).toThrow(/does not match the loaded value/);
  });

  it("accepts its own current source as policy-clean", async () => {
    const source = await readFile(absolute("scripts/check-module-size.mjs"), "utf8");
    expect(() => assertPolicyLiterals(source)).not.toThrow();
  });

  it("counts physical lines including a final unterminated line", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\nb\n")).toBe(2);
  });

  it("keeps the real tree under the cap", async () => {
    const { execFileSync } = await import("node:child_process");
    const output = execFileSync("node", [absolute("scripts/check-module-size.mjs"), "--json"], {
      cwd: absolute("."),
      encoding: "utf8",
    });
    const report = JSON.parse(output) as {
      scanned: number;
      violations: readonly unknown[];
    };

    expect(report.scanned).toBeGreaterThan(0);
    expect(report.violations).toEqual([]);
  });
});
