import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  MODULE_SIZE_POLICY_ID,
  RESEED_SLACK,
  SOFT_CAP,
  assertPolicyLiterals,
  ceilingFor,
  comparePolicySources,
  countLines,
  evaluate,
} from "../../scripts/check-module-size.mjs";
import { absolute } from "./repo-root.js";

function policySource({
  sourceExtensions = [".ts", ".mts"],
  grandfathered = {},
  excluded = [],
  softCap = 2000,
}: {
  sourceExtensions?: string[];
  grandfathered?: Record<string, number>;
  excluded?: string[];
  softCap?: number;
} = {}) {
  return [
    'export const MODULE_SIZE_POLICY_ID = "oms.module-size.v1";',
    'export const SOURCE_ROOT = "src";',
    `export const SOURCE_EXTENSIONS = ${JSON.stringify(sourceExtensions)};`,
    `export const SOFT_CAP = ${softCap};`,
    "export const RESEED_SLACK = 200;",
    `export const GRANDFATHERED = Object.freeze(${JSON.stringify(grandfathered)});`,
    `export const EXCLUDED = Object.freeze(${JSON.stringify(excluded)});`,
  ].join("\n");
}

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
    expect(ceilingFor("src/kernel/capture/safe.ts")).toBe(SOFT_CAP);
    expect(ceilingFor("anything/at/all.ts")).toBe(SOFT_CAP);
  });

  it("rejects a policy constant that is not a literal", () => {
    const tampered = [
      'export const MODULE_SIZE_POLICY_ID = "oms.module-size.v1";',
      'export const SOURCE_ROOT = "src";',
      'export const SOURCE_EXTENSIONS = [".ts"];',
      "export const SOFT_CAP = Number(process.env.CAP ?? 2000);",
      "export const RESEED_SLACK = 200;",
      "export const GRANDFATHERED = Object.freeze({});",
      "export const EXCLUDED = Object.freeze([]);",
    ].join("\n");

    expect(() => assertPolicyLiterals(tampered)).toThrow(/SOFT_CAP is not a literal assignment/);
  });

  it("rejects a raised cap even when the policy sentinel changes with it", () => {
    const base = policySource();
    const head = policySource({ softCap: 2500 }).replace(
      'MODULE_SIZE_POLICY_ID = "oms.module-size.v1"',
      'MODULE_SIZE_POLICY_ID = "oms.module-size.v2-relaxed"',
    );

    expect(comparePolicySources(base, head)).toEqual([
      'MODULE_SIZE_POLICY_ID changed from "oms.module-size.v1" to "oms.module-size.v2-relaxed"',
      "SOFT_CAP rose from 2000 to 2500",
    ]);
  });

  it("accepts a lower cap", () => {
    const base = policySource();
    const head = base.replace("SOFT_CAP = 2000", "SOFT_CAP = 1900");

    expect(comparePolicySources(base, head)).toEqual([]);
  });

  it("rejects excluding a file that the baseline scans", () => {
    const violations = comparePolicySources(
      policySource(),
      policySource({ excluded: ["src/kernel/oversized.ts"] }),
    );

    expect(violations).toEqual(['EXCLUDED added "src/kernel/oversized.ts"']);
  });

  it("accepts removing an excluded file", () => {
    expect(
      comparePolicySources(
        policySource({ excluded: ["src/kernel/generated.ts"] }),
        policySource(),
      ),
    ).toEqual([]);
  });

  it("rejects raising a grandfathered file's recorded size", () => {
    const violations = comparePolicySources(
      policySource({ grandfathered: { "src/kernel/oversized.ts": 2100 } }),
      policySource({ grandfathered: { "src/kernel/oversized.ts": 2600 } }),
    );

    expect(violations).toEqual(['GRANDFATHERED "src/kernel/oversized.ts" rose from 2100 to 2600']);
  });

  it("rejects granting a file a new grandfathered ceiling", () => {
    const violations = comparePolicySources(
      policySource(),
      policySource({ grandfathered: { "src/kernel/oversized.ts": 2100 } }),
    );

    expect(violations).toEqual(['GRANDFATHERED added "src/kernel/oversized.ts" at 2100']);
  });

  it("accepts lowering a grandfathered file's recorded size", () => {
    expect(
      comparePolicySources(
        policySource({ grandfathered: { "src/kernel/oversized.ts": 2600 } }),
        policySource({ grandfathered: { "src/kernel/oversized.ts": 2100 } }),
      ),
    ).toEqual([]);
  });

  it("rejects removing a source extension that the baseline scans", () => {
    const violations = comparePolicySources(
      policySource({ sourceExtensions: [".ts"] }),
      policySource({ sourceExtensions: [] }),
    );

    expect(violations).toEqual(['SOURCE_EXTENSIONS removed ".ts"']);
  });

  it("accepts adding a source extension", () => {
    expect(
      comparePolicySources(
        policySource({ sourceExtensions: [".ts"] }),
        policySource({ sourceExtensions: [".ts", ".tsx"] }),
      ),
    ).toEqual([]);
  });

  it("scans an oversized .mts production module", () => {
    expect(
      evaluate({
        files: ["src/kernel/oversize.mts"],
        currentLines: { "src/kernel/oversize.mts": SOFT_CAP + 205 },
        baselineLines: null,
      }),
    ).toMatchObject([{ file: "src/kernel/oversize.mts", kind: "over-ceiling" }]);
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
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("node", [absolute("scripts/check-module-size.mjs"), "--json"], {
      cwd: absolute("."),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("no baseline ref supplied; policy comparison was skipped");
    const report = JSON.parse(result.stdout) as {
      baselineStatus: string;
      scanned: number;
      violations: readonly unknown[];
    };

    expect(report.baselineStatus).toBe("unavailable");
    expect(report.scanned).toBeGreaterThan(0);
    expect(report.violations).toEqual([]);
  });
});
