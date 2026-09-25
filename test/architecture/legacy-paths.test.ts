import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { absolute, assertNonVacuous, collectFiles } from "./repo-root.js";

/**
 * The retired template runtime must not come back through code, tests,
 * scripts, the package manifest, the shipped host assets, or the skills. Each pattern uses a
 * bracket class so this file never matches itself; `.obsidian/types.json` is
 * Obsidian's own file and stays legal.
 */
const LEGACY_PATTERNS: readonly RegExp[] = [
  /template[-]policy/iu,
  /\.oms\/t[y]pes\.json/iu,
  /t[a]xonomy/iu,
  /(?<![-\w])m[o]dels\.json/iu,
  /contract[-]public\.json/iu,
  /\.oms\/v[a]ult-id/iu,
  /template[-]transaction/iu,
  /template[-]backfill/iu,
  /template[-]migration/iu,
  /template[-]interview/iu,
  /history\/c[o]ntracts\//iu,
  /\.template[-]transactions\//iu,
  /\.oms\/t[e]mplates\//iu,
  /kernel\/t[e]mplates\//iu,
  /OMS[_]GUARD/iu,
  /post[-]guard/iu,
  /template[R]oots/iu,
  /template[N]otice/iu,
  /OMS_CONTRACT[_]STORE_ROOT/iu,
];

/** (file, pattern source) pairs only; a whole file is never exempt. */
const ALLOWED: readonly (readonly [file: string, pattern: string])[] = [];

const SCAN_ROOTS = ["src", "test", "scripts", "assets", "skills"] as const;

describe("legacy template paths stay retired", () => {
  it("finds no legacy path in code, tests, scripts, the manifest, host assets, or skills", async () => {
    const files = ["package.json"];
    for (const root of SCAN_ROOTS) files.push(...await collectFiles(root, () => true));
    assertNonVacuous(files, "legacy path scan");

    const found: string[] = [];
    for (const file of files) {
      const bytes = await readFile(absolute(file));
      if (bytes.includes(0)) continue;
      const text = bytes.toString("utf8");
      for (const pattern of LEGACY_PATTERNS) {
        if (!pattern.test(text)) continue;
        if (ALLOWED.some(([allowedFile, source]) => allowedFile === file && source === pattern.source)) continue;
        found.push(`${file}: ${pattern.source}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("keeps Obsidian's own property types file legal", () => {
    const obsidian = [".obsidian", "types.json"].join("/");
    expect(LEGACY_PATTERNS.filter(pattern => pattern.test(obsidian))).toEqual([]);
    expect(LEGACY_PATTERNS.some(pattern => pattern.test([".oms", "types.json"].join("/")))).toBe(true);
  });
});
