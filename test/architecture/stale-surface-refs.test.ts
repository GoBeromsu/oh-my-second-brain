import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { absolute, assertNonVacuous, collectFiles, pathExists } from "./repo-root.js";

/**
 * 0.19 replaced the public surface. User-facing prose must not keep teaching the
 * retired MCP tools (`oms_status`, `oms_link`) or the retired CLI families
 * (`oms contract`, `oms note`, ...). Historical records are exempt: changelogs,
 * ADRs, research, the migration guide that maps old to new, and measurement
 * docs pinned to a released 0.18 build.
 */
const SCAN_ROOTS = ["assets", "docs", "skills"] as const;
const ROOT_FILES = ["AGENTS.md", "README.md", "README.ko.md"] as const;
const TEXT_FILE = /\.(?:md|mjs|js|json|toml|ya?ml|sh|txt)$/;

const EXCLUDED: readonly RegExp[] = [
  /(?:^|\/)CHANGELOG-[^/]*$/,
  /^docs\/decisions\//,
  /^docs\/research\//,
  /^docs\/migration-0\.19\.md$/,
  /^docs\/measurements\/[^/]*0\.18[^/]*$/,
  /^\.omc\//,
];

const RETIRED_TOOL = /\b(?:oms_|mcp__oms__)(?:status|link)\b/g;
/**
 * A retired family used as a command: `oms <family>` at a command position
 * (line start, list bullet, shell prompt, backtick or quote). Prose such as
 * "the installed oms package" and setup leaves such as `oms setup host` do not
 * match because the family word must follow `oms ` directly.
 */
const RETIRED_COMMAND =
  /(?:^|[`'"(]|\$ |^\s*[-*] )oms (?:contract|note|index|graph|link|status|host|model|package|bridge)\b/gm;

async function scannedFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    files.push(...(await collectFiles(root, (file) => TEXT_FILE.test(file))));
  }
  for (const file of ROOT_FILES) {
    if (await pathExists(file)) files.push(file);
  }
  return files.filter((file) => !EXCLUDED.some((pattern) => pattern.test(file)));
}

function hits(file: string, source: string): string[] {
  const found: string[] = [];
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    for (const pattern of [RETIRED_TOOL, RETIRED_COMMAND]) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) found.push(`${file}:${index + 1}: ${match[0].trim()}`);
    }
  });
  return found;
}

describe("stale 0.18 surface references", () => {
  it("scans user-facing docs, assets, skills and root guidance", async () => {
    const files = await scannedFiles();
    assertNonVacuous(files, "stale surface references");
    expect(files).toContain("AGENTS.md");
    expect(files.some((file) => file.startsWith("assets/"))).toBe(true);
    expect(files.some((file) => file.startsWith("docs/"))).toBe(true);
  });

  it("no scanned file names a retired MCP tool or CLI family", async () => {
    const found: string[] = [];
    for (const file of await scannedFiles()) {
      found.push(...hits(file, await readFile(absolute(file), "utf8")));
    }
    expect(found).toEqual([]);
  });

  it("flags retired spellings and allows setup leaves and prose", () => {
    expect(hits("x.md", "call `oms_status` then `mcp__oms__link`")).toHaveLength(2);
    expect(hits("x.md", "run `oms contract doctor`")).toHaveLength(1);
    expect(hits("x.md", "- oms note audit")).toHaveLength(1);
    expect(hits("x.md", "$ oms status")).toHaveLength(1);
    expect(hits("x.md", "run `oms setup host install`")).toEqual([]);
    expect(hits("x.md", "the installed oms package")).toEqual([]);
    expect(hits("x.md", "`oms doctor status`")).toEqual([]);
  });

  it("exempts historical records", () => {
    const excluded = (file: string) => EXCLUDED.some((pattern) => pattern.test(file));
    expect(excluded("CHANGELOG-cli.md")).toBe(true);
    expect(excluded("docs/decisions/ADR-001.md")).toBe(true);
    expect(excluded("docs/migration-0.19.md")).toBe(true);
    expect(excluded("docs/measurements/latency-baseline-0.18.3.md")).toBe(true);
    expect(excluded("docs/measurements/latency-search-path.md")).toBe(false);
    expect(excluded("docs/cli-map.md")).toBe(false);
  });
});
