import { describe, it, expect } from "vitest";
// @ts-expect-error - release.mjs is plain ESM JavaScript shared with scripts/*.mjs (no .d.ts by design)
import * as releaseCliModule from "../scripts/release.mjs";

type ParsedRelease =
  | { mode: "watch" }
  | { mode: "release"; version: string; allowEmptyChangelog: boolean };

interface ReleaseCli {
  parseReleaseCli(argv: string[]): ParsedRelease;
}

const { parseReleaseCli } = releaseCliModule as ReleaseCli;

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

  it("exports only the pure parser (main flow stays behind the import.meta guard)", () => {
    // A non-guarded main would run preflight (git/gh) or exit during this import.
    expect(Object.keys(releaseCliModule as object)).toEqual(["parseReleaseCli"]);
  });
});
