import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error - release.mjs is plain ESM JavaScript shared with scripts/*.mjs (no .d.ts by design)
import * as releaseCliModule from "../scripts/release.mjs";

type ParsedRelease =
  | { mode: "watch" }
  | { mode: "release"; version: string; allowEmptyChangelog: boolean };

interface ReleaseCli {
  parseReleaseCli(argv: string[]): ParsedRelease;
  rollChangelogs(paths: readonly string[], version: string, date: string, allowEmptyAggregate: boolean): void;
}

const { parseReleaseCli, rollChangelogs } = releaseCliModule as ReleaseCli;
const CHANGELOG_FILES = [
  "CHANGELOG.md",
  "CHANGELOG-kernel.md",
  "CHANGELOG-cli.md",
  "CHANGELOG-mcp.md",
  "CHANGELOG-vendors.md",
  "CHANGELOG-assets.md",
];
const EXTRACT_RELEASE_NOTES = fileURLToPath(new URL("../scripts/extract-release-notes.mjs", import.meta.url));

function changelog(body: string, previous = "- preserved historical entry"): string {
  return `# Changelog\n\n## [Unreleased]\n\n${body}\n\n## [0.1.0] - 2026-01-01\n\n${previous}\n`;
}

describe("parseReleaseCli", () => {
  it("parses a stable version into release mode", () => {
    expect(parseReleaseCli(["1.2.3"])).toEqual({
      mode: "release",
      version: "1.2.3",
      allowEmptyChangelog: false,
    });
  });

  it("parses the watch subcommand", () => {
    expect(parseReleaseCli(["watch"])).toEqual({ mode: "watch" });
  });

  it("parses --allow-empty-changelog", () => {
    expect(parseReleaseCli(["0.2.0", "--allow-empty-changelog"])).toEqual({
      mode: "release",
      version: "0.2.0",
      allowEmptyChangelog: true,
    });
  });

  it("throws on an invalid version", () => {
    expect(() => parseReleaseCli(["not-a-version"])).toThrow(/invalid version: not-a-version/);
    expect(() => parseReleaseCli(["v1.2.3"])).toThrow(/invalid version: v1\.2\.3/);
    expect(() => parseReleaseCli(["1.2.3-rc.1"])).toThrow(/invalid version/);
    expect(() => parseReleaseCli(["1.2"])).toThrow(/invalid version/);
  });

  it("throws on unknown or extra arguments", () => {
    expect(() => parseReleaseCli(["1.2.3", "--force"])).toThrow(/unexpected argument: --force/);
    expect(() => parseReleaseCli(["1.2.3", "1.2.4"])).toThrow(/unexpected argument: 1\.2\.4/);
    expect(() => parseReleaseCli(["watch", "1.2.3"])).toThrow(/invalid version: watch/);
    expect(() => parseReleaseCli(["1.2.3", "--allow-empty-changelog", "--allow-empty-changelog"])).toThrow(
      /duplicate flag: --allow-empty-changelog/,
    );
  });

  it("throws with usage when no arguments are given", () => {
    expect(() => parseReleaseCli([])).toThrow(/invalid version: \(none\)/);
    expect(() => parseReleaseCli([])).toThrow(/usage: npm run release -- <X\.Y\.Z>/);
  });

  it("exports the parser and changelog transaction without running main on import", () => {
    // A non-guarded main would run preflight (git/gh) or exit during this import.
    expect(Object.keys(releaseCliModule as object).sort()).toEqual(["parseReleaseCli", "rollChangelogs"]);
  });
});

describe("rollChangelogs", () => {
  it("rolls all layers before release-note extraction while preserving historical entries", () => {
    const directory = mkdtempSync(join(tmpdir(), "oms-release-changelogs-"));
    const version = "0.2.0";
    const contents = new Map<string, string>([
      ["CHANGELOG.md", changelog("- aggregate release note").replace("# Changelog\n\n", "# Changelog\n\nAggregate introduction.\n\n")],
      ["CHANGELOG-kernel.md", changelog("- kernel release note")],
      ["CHANGELOG-cli.md", changelog("- cli release note")],
      ["CHANGELOG-mcp.md", changelog("- mcp release note")],
      ["CHANGELOG-vendors.md", changelog("- vendors release note")],
      ["CHANGELOG-assets.md", changelog("")],
    ]);

    try {
      for (const [file, content] of contents) writeFileSync(join(directory, file), content);

      rollChangelogs(
        CHANGELOG_FILES.map((file) => join(directory, file)),
        version,
        "2026-08-24",
        false,
      );

      for (const file of CHANGELOG_FILES) {
        const rolled = readFileSync(join(directory, file), "utf-8");
        const original = contents.get(file) as string;
        const historicalStart = original.indexOf("## [0.1.0]");
        expect(rolled).toContain(`## [${version}] - 2026-08-24`);
        expect(rolled).toMatch(new RegExp(`## \\[Unreleased\\]\\n\\n## \\[${version}\\]`));
        expect(rolled.slice(rolled.indexOf("## [0.1.0]"))).toBe(original.slice(historicalStart));
      }

      const notes = execFileSync(process.execPath, [EXTRACT_RELEASE_NOTES, version], {
        cwd: directory,
        encoding: "utf-8",
      });
      expect(notes).toContain("## Aggregate\n\n- aggregate release note");
      expect(notes).toContain("## Kernel\n\n- kernel release note");
      expect(notes).toContain("## CLI\n\n- cli release note");
      expect(notes).toContain("## MCP\n\n- mcp release note");
      expect(notes).toContain("## Vendors\n\n- vendors release note");
      expect(notes).toContain("## Assets\n\n_No entries._");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not write any changelog when verification finds a malformed layer", () => {
    const directory = mkdtempSync(join(tmpdir(), "oms-release-changelog-failure-"));
    const paths = CHANGELOG_FILES.map((file) => join(directory, file));
    try {
      for (const path of paths) writeFileSync(path, changelog("- release note"));
      writeFileSync(paths[3], "# not a changelog\n");
      const before = paths.map((path) => readFileSync(path, "utf-8"));

      expect(() => rollChangelogs(paths, "0.2.0", "2026-08-24", false)).toThrow(/before any changelog was written/);
      expect(paths.map((path) => readFileSync(path, "utf-8"))).toEqual(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
