import { describe, it, expect } from "vitest";
// @ts-expect-error - release-lib.mjs is plain ESM JavaScript shared with scripts/*.mjs (no .d.ts by design)
import * as releaseLibModule from "../scripts/release-lib.mjs";

interface VersionCarrier {
  version?: string;
}

interface PackageLockShape extends VersionCarrier {
  packages?: Record<string, VersionCarrier>;
}

// .claude-plugin/marketplace.json carries the version twice: top-level and plugins[0].
interface MarketplaceShape extends VersionCarrier {
  plugins?: VersionCarrier[];
}

interface VersionCarriers {
  version: string;
  packageJson: VersionCarrier;
  packageLock: PackageLockShape;
  claudePluginJson: VersionCarrier;
  codexPluginJson: VersionCarrier;
  hermesManifestJson: VersionCarrier;
  marketplaceJson: MarketplaceShape;
}

interface ReleaseLib {
  isStableVersion(version: string): boolean;
  isVersionGreater(a: string, b: string): boolean;
  rolledChangelog(content: string, version: string, date: string, options?: { allowEmpty?: boolean }): string;
  extractReleaseNotes(content: string, version: string): string;
  bumpedJsonVersion(jsonText: string, version: string): string;
  bumpedPackageLock(jsonText: string, version: string): string;
  bumpedMarketplace(jsonText: string): string;
  versionMismatches(carriers: VersionCarriers): string[];
  missingReleasedHeadings(baseChangelogs: Record<string, string>, headChangelogs: Record<string, string>): string[];
  alteredReleasedSections(baseChangelogs: Record<string, string>, headChangelogs: Record<string, string>): string[];
  relocatedReleasedSections(
    baseChangelogs: Record<string, string>,
    headChangelogs: Record<string, string>,
  ): { fromFile: string; toFile: string; heading: string }[];
}

const {
  isStableVersion,
  isVersionGreater,
  rolledChangelog,
  extractReleaseNotes,
  bumpedJsonVersion,
  bumpedPackageLock,
  bumpedMarketplace,
  versionMismatches,
  missingReleasedHeadings,
  alteredReleasedSections,
  relocatedReleasedSections,
} = releaseLibModule as ReleaseLib;

const RELEASED_0_1_9 = "## [0.1.9] - 2026-08-14\n\n### Added\n\n- hermes adapter (#59)\n";
const RELEASED_0_1_8 = "## [0.1.8] - 2026-06-17\n\n- codex parity fixes\n";
const CHANGELOG = `# Changelog\n\n## [Unreleased]\n\n- something new\n\n${RELEASED_0_1_9}\n${RELEASED_0_1_8}`;
const EMPTY_UNRELEASED_CHANGELOG = `# Changelog\n\n## [Unreleased]\n\n${RELEASED_0_1_9}\n${RELEASED_0_1_8}`;

// package-lock.json in this repo carries the version twice: root .version and .packages[""].version.
const PACKAGE_LOCK = JSON.stringify(
  {
    name: "oh-my-second-brain",
    version: "0.1.9",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "oh-my-second-brain", version: "0.1.9", license: "MIT" },
      "node_modules/yaml": { version: "2.5.0" },
    },
  },
  null,
  2,
);

// Mirrors the on-disk .claude-plugin/marketplace.json: the first "version" text
// token is plugins[0].version, and the top-level "version" key comes last.
const MARKETPLACE = `${JSON.stringify(
  {
    $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
    name: "oms",
    description: "Oh My Second Brain",
    owner: { name: "gobeumsu", email: "gobeumsu@gmail.com" },
    plugins: [{ name: "oms", description: "convention layer", version: "0.1.9", source: "./" }],
    version: "0.1.9",
  },
  null,
  2,
)}\n`;

describe("isStableVersion", () => {
  it("accepts stable X.Y.Z versions including 0.x", () => {
    expect(isStableVersion("0.1.9")).toBe(true);
    expect(isStableVersion("1.0.0")).toBe(true);
    expect(isStableVersion("10.20.30")).toBe(true);
  });

  it("rejects prereleases, leading zeros, and garbage", () => {
    expect(isStableVersion("1.0.0-rc.1")).toBe(false);
    expect(isStableVersion("01.0.0")).toBe(false);
    expect(isStableVersion("1.0")).toBe(false);
    expect(isStableVersion("v1.0.0")).toBe(false);
    expect(isStableVersion("not-a-version")).toBe(false);
  });
});

describe("isVersionGreater", () => {
  it("compares segments numerically, not lexicographically", () => {
    expect(isVersionGreater("0.1.10", "0.1.9")).toBe(true);
    expect(isVersionGreater("0.1.9", "0.1.10")).toBe(false);
    expect(isVersionGreater("0.2.0", "0.1.9")).toBe(true);
    expect(isVersionGreater("1.0.0", "0.99.99")).toBe(true);
  });

  it("returns false for equal versions and throws on malformed input", () => {
    expect(isVersionGreater("0.1.9", "0.1.9")).toBe(false);
    expect(() => isVersionGreater("1.0", "0.1.9")).toThrow(/expected X\.Y\.Z/);
  });
});

describe("rolledChangelog", () => {
  it("rolls a non-empty [Unreleased] into a dated section and reinstates an empty [Unreleased]", () => {
    const rolled = rolledChangelog(CHANGELOG, "0.2.0", "2026-08-17");
    expect(rolled).toBe(
      `# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-08-17\n\n- something new\n\n${RELEASED_0_1_9}\n${RELEASED_0_1_8}`,
    );
    expect(extractReleaseNotes(rolled, "0.2.0")).toBe("- something new");
  });

  it("passes released sections through byte-identically", () => {
    const rolled = rolledChangelog(CHANGELOG, "0.2.0", "2026-08-17");
    expect(rolled).toContain(RELEASED_0_1_9);
    expect(rolled).toContain(RELEASED_0_1_8);
    expect(rolled.slice(rolled.indexOf("## [0.1.9]"))).toBe(CHANGELOG.slice(CHANGELOG.indexOf("## [0.1.9]")));
  });

  it("throws when [Unreleased] is empty and allowEmpty is not set", () => {
    expect(() => rolledChangelog(EMPTY_UNRELEASED_CHANGELOG, "0.2.0", "2026-08-17")).toThrow(/empty \[Unreleased\]/);
  });

  it("inserts an empty release section below an intact [Unreleased] when allowEmpty is set", () => {
    const rolled = rolledChangelog(EMPTY_UNRELEASED_CHANGELOG, "0.2.0", "2026-08-17", { allowEmpty: true });
    expect(rolled).toBe(
      `# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-08-17\n\n${RELEASED_0_1_9}\n${RELEASED_0_1_8}`,
    );
    expect(extractReleaseNotes(rolled, "0.2.0")).toBe("");
  });

  it("throws when rolled twice for the same version because [Unreleased] is empty again", () => {
    const once = rolledChangelog(CHANGELOG, "0.2.0", "2026-08-17");
    expect(() => rolledChangelog(once, "0.2.0", "2026-08-17")).toThrow(/empty \[Unreleased\]/);
  });

  it("throws when the '# Changelog' header is missing or malformed", () => {
    expect(() => rolledChangelog("no header\n\n## [Unreleased]\n\n- x\n", "1.0.0", "2026-01-01")).toThrow(
      /# Changelog/,
    );
    expect(() => rolledChangelog("## Changelog\n\n## [Unreleased]\n\n- x\n", "1.0.0", "2026-01-01")).toThrow(
      /# Changelog/,
    );
    expect(() => rolledChangelog("", "1.0.0", "2026-01-01")).toThrow(/# Changelog/);
  });

  it("throws when the [Unreleased] section is absent", () => {
    expect(() => rolledChangelog(`# Changelog\n\n${RELEASED_0_1_9}`, "1.0.0", "2026-01-01")).toThrow(
      /\[Unreleased\]/,
    );
  });

  it("rejects duplicate [Unreleased] headings rather than rolling an ambiguous section", () => {
    const duplicateUnreleased = "# Changelog\n\n## [Unreleased]\n\n- first\n\n## [Unreleased]\n\n- second\n";
    expect(() => rolledChangelog(duplicateUnreleased, "0.1.0", "2026-01-01")).toThrow(/duplicate heading.*Unreleased/);
  });

  it("rolls a changelog whose only section is [Unreleased]", () => {
    expect(rolledChangelog("# Changelog\n\n## [Unreleased]\n\n- first release\n", "0.1.0", "2026-01-01")).toBe(
      "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n- first release\n",
    );
  });
});

describe("extractReleaseNotes", () => {
  it("extracts a middle section trimmed of surrounding blank lines", () => {
    expect(extractReleaseNotes(CHANGELOG, "0.1.9")).toBe("### Added\n\n- hermes adapter (#59)");
  });

  it("extracts the last section up to EOF", () => {
    expect(extractReleaseNotes(CHANGELOG, "0.1.8")).toBe("- codex parity fixes");
  });

  it("throws when the requested version has no section", () => {
    expect(() => extractReleaseNotes(CHANGELOG, "9.9.9")).toThrow(/9\.9\.9/);
    expect(() => extractReleaseNotes("garbage content", "0.1.9")).toThrow(/missing changelog section/);
  });
});

describe("bumpedJsonVersion", () => {
  it("replaces only the first top-level version and preserves formatting", () => {
    const source = [
      "{",
      '  "name": "oh-my-second-brain",',
      '  "version": "0.1.9",',
      '  "engines": { "node": ">=20" },',
      '  "nested": { "version": "0.0.1" }',
      "}",
      "",
    ].join("\n");
    const bumped = bumpedJsonVersion(source, "0.2.0");
    expect(bumped).toBe(source.replace('"version": "0.1.9"', '"version": "0.2.0"'));
    expect(bumped).toContain('"nested": { "version": "0.0.1" }');
  });

  it("throws on malformed input and invalid versions", () => {
    expect(() => bumpedJsonVersion('{"name":"x"}', "0.2.0")).toThrow(/no "version" field/);
    expect(() => bumpedJsonVersion('{"version":"0.1.9"}', "0.2.0-rc.1")).toThrow(/expected X\.Y\.Z/);
  });
});

describe("bumpedPackageLock", () => {
  it("sets both the root version and packages[''] version with a trailing newline", () => {
    const bumped = bumpedPackageLock(PACKAGE_LOCK, "0.2.0");
    const parsed = JSON.parse(bumped) as PackageLockShape;
    expect(parsed.version).toBe("0.2.0");
    expect(parsed.packages?.[""]?.version).toBe("0.2.0");
    expect(parsed.packages?.["node_modules/yaml"]?.version).toBe("2.5.0");
    expect(bumped.endsWith("\n")).toBe(true);
    expect(bumped).toContain('\n  "version": "0.2.0",');
  });

  it("throws when the lockfile has no packages[''] entry", () => {
    expect(() => bumpedPackageLock('{"name":"x","version":"0.1.9"}', "0.2.0")).toThrow(/packages\[""\]/);
  });
});

describe("bumpedMarketplace", () => {
  it("sets both the top-level version and plugins[0].version, leaving valid JSON", () => {
    // Given: a marketplace manifest at 0.1.9 in both carriers
    // When: it is bumped to the release version
    const bumped = bumpedMarketplace(MARKETPLACE, "0.2.0");
    // Then: the round-tripped JSON carries 0.2.0 in both places, other fields intact
    const parsed = JSON.parse(bumped) as MarketplaceShape & { name?: string; plugins?: { source?: string }[] };
    expect(parsed.version).toBe("0.2.0");
    expect(parsed.plugins?.[0]?.version).toBe("0.2.0");
    expect(parsed.name).toBe("oms");
    expect(parsed.plugins?.[0]?.source).toBe("./");
    expect(bumped.endsWith("\n")).toBe(true);
  });

  it("throws on a manifest without plugins[0] and on invalid versions", () => {
    expect(() => bumpedMarketplace('{"name":"oms","plugins":[]}', "0.2.0")).toThrow(/plugins\[0\]/);
    expect(() => bumpedMarketplace(MARKETPLACE, "0.2.0-rc.1")).toThrow(/expected X\.Y\.Z/);
  });
});

// bumpedJsonVersion is the generic text bump used for the single-version carriers.
// Documenting its behavior on the marketplace shape proves why that manifest needs
// bumpedMarketplace instead: the first "version" pair is plugins[0].version, so the
// top-level carrier would silently stay behind.
describe("bumpedJsonVersion on the marketplace shape", () => {
  it("targets plugins[0].version and leaves the trailing top-level version stale", () => {
    const bumped = bumpedJsonVersion(MARKETPLACE, "0.2.0");
    const parsed = JSON.parse(bumped) as MarketplaceShape;
    expect(parsed.plugins?.[0]?.version).toBe("0.2.0");
    expect(parsed.version).toBe("0.1.9");
  });
});

describe("versionMismatches", () => {
  const consistent = (): VersionCarriers => ({
    version: "0.2.0",
    packageJson: { version: "0.2.0" },
    packageLock: { version: "0.2.0", packages: { "": { version: "0.2.0" } } },
    claudePluginJson: { version: "0.2.0" },
    codexPluginJson: { version: "0.2.0" },
    hermesManifestJson: { version: "0.2.0" },
    marketplaceJson: { version: "0.2.0", plugins: [{ version: "0.2.0" }] },
  });

  it("returns an empty array when every carrier matches", () => {
    expect(versionMismatches(consistent())).toEqual([]);
  });

  it("names each mismatching carrier", () => {
    const carriers = consistent();
    carriers.packageJson = { version: "0.1.9" };
    carriers.packageLock = { version: "0.1.9", packages: { "": { version: "0.1.8" } } };
    carriers.claudePluginJson = {};
    carriers.codexPluginJson = { version: "0.1.9" };
    carriers.hermesManifestJson = { version: "0.1.9" };
    carriers.marketplaceJson = { version: "0.1.9", plugins: [{ version: "0.1.8" }] };

    const mismatches = versionMismatches(carriers);
    expect(mismatches).toHaveLength(8);
    expect(mismatches[0]).toBe("package.json=0.1.9 (expected 0.2.0)");
    expect(mismatches[1]).toBe("package-lock.json=0.1.9 (expected 0.2.0)");
    expect(mismatches[2]).toBe('package-lock.json packages[""]=0.1.8 (expected 0.2.0)');
    // The plugin roots moved to the repository root so a single assets/skills/
    // tree is an in-root reference for every host; the carrier labels follow.
    expect(mismatches[3]).toBe(".claude-plugin/plugin.json=missing (expected 0.2.0)");
    expect(mismatches[4]).toBe(".codex-plugin/plugin.json=0.1.9 (expected 0.2.0)");
    expect(mismatches[5]).toBe("assets/hermes-manifest.json=0.1.9 (expected 0.2.0)");
    expect(mismatches[6]).toBe(".claude-plugin/marketplace.json=0.1.9 (expected 0.2.0)");
    expect(mismatches[7]).toBe(".claude-plugin/marketplace.json plugins[0]=0.1.8 (expected 0.2.0)");
  });

  it("reports a drifted marketplace carrier even when every other carrier matches", () => {
    // Given: a fully consistent release except a stale marketplace plugins[0]
    const carriers = consistent();
    carriers.marketplaceJson = { version: "0.2.0", plugins: [{ version: "0.1.9" }] };
    // When: the carriers are compared against the release version
    const mismatches = versionMismatches(carriers);
    // Then: only the drifted nested carrier is named
    expect(mismatches).toEqual(['.claude-plugin/marketplace.json plugins[0]=0.1.9 (expected 0.2.0)']);
  });

  it("reports a marketplace manifest that lost its version fields entirely", () => {
    const carriers = consistent();
    carriers.marketplaceJson = { plugins: [{}] };
    expect(versionMismatches(carriers)).toEqual([
      ".claude-plugin/marketplace.json=missing (expected 0.2.0)",
      '.claude-plugin/marketplace.json plugins[0]=missing (expected 0.2.0)',
    ]);
  });
});

describe("missingReleasedHeadings", () => {
  it("detects a removed released heading", () => {
    expect(
      missingReleasedHeadings(
        { "CHANGELOG-cli.md": CHANGELOG },
        { "CHANGELOG-cli.md": `# Changelog\n\n## [Unreleased]\n\n${RELEASED_0_1_9}` },
      ),
    ).toEqual(["CHANGELOG-cli.md: ## [0.1.8]"]);
  });

  it("returns [] for identical content, added sections, and edited bodies", () => {
    expect(missingReleasedHeadings({ "CHANGELOG.md": CHANGELOG }, { "CHANGELOG.md": CHANGELOG })).toEqual([]);
    const withNewRelease = rolledChangelog(CHANGELOG, "0.2.0", "2026-08-17");
    expect(missingReleasedHeadings({ "CHANGELOG.md": CHANGELOG }, { "CHANGELOG.md": withNewRelease })).toEqual([]);
    expect(
      missingReleasedHeadings(
        { "CHANGELOG.md": CHANGELOG },
        { "CHANGELOG.md": CHANGELOG.replace("- codex parity fixes", "- reworded") },
      ),
    ).toEqual([]);
  });

  it("ignores [Unreleased] and treats a missing base changelog as no removals", () => {
    expect(
      missingReleasedHeadings(
        { "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n" },
        { "CHANGELOG.md": "# Changelog\n" },
      ),
    ).toEqual([]);
    expect(missingReleasedHeadings({ "CHANGELOG.md": "" }, { "CHANGELOG.md": CHANGELOG })).toEqual([]);
  });
});

describe("alteredReleasedSections", () => {
  it("keeps section identities scoped to their changelog files", () => {
    const base = {
      "CHANGELOG-cli.md": CHANGELOG,
      "CHANGELOG-mcp.md": CHANGELOG,
    };
    const head = {
      "CHANGELOG-cli.md": CHANGELOG.replace("- codex parity fixes", "- rewritten cli history"),
      "CHANGELOG-mcp.md": CHANGELOG,
    };

    expect(alteredReleasedSections(base, head)).toEqual(["CHANGELOG-cli.md: ## [0.1.8]"]);
  });

  it("rejects an edit beneath a nested release subsection", () => {
    const base = {
      "CHANGELOG.md": "# Changelog\n\n## [0.1.0] - 2026-01-01\n\n### Changed\n\n- preserved behaviour\n",
    };
    const head = {
      "CHANGELOG.md": base["CHANGELOG.md"].replace("preserved behaviour", "rewritten behaviour"),
    };

    expect(alteredReleasedSections(base, head)).toEqual(["CHANGELOG.md: ## [0.1.0]"]);
  });

  it("rejects a date change while the release body is identical", () => {
    const base = {
      "CHANGELOG.md": "# Changelog\n\n## [0.1.0] - 2026-01-01\n\n### Fixed\n\n- preserved behaviour\n",
    };
    const head = {
      "CHANGELOG.md": base["CHANGELOG.md"].replace("2026-01-01", "2026-01-02"),
    };

    expect(alteredReleasedSections(base, head)).toEqual(["CHANGELOG.md: ## [0.1.0]"]);
  });
});

describe("released section relocations", () => {
  const source = "# Changelog\n\n## [0.1.0] - 2026-01-01\n\n### Changed\n\n- preserved\n";
  const destination = "# Changelog\n\n## [Unreleased]\n";

  it("accepts and reports a byte-identical move to a file that lacked the version at base", () => {
    const base = { "CHANGELOG.md": source, "CHANGELOG-vendors.md": destination };
    const head = {
      "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n",
      "CHANGELOG-vendors.md": `${destination}\n## [0.1.0] - 2026-01-01\n\n### Changed\n\n- preserved\n`,
    };

    expect(missingReleasedHeadings(base, head)).toEqual([]);
    expect(relocatedReleasedSections(base, head)).toEqual([
      { fromFile: "CHANGELOG.md", toFile: "CHANGELOG-vendors.md", heading: "## [0.1.0]" },
    ]);
  });

  it("rejects a move whose destination nested bullet changed", () => {
    const base = { "CHANGELOG.md": source, "CHANGELOG-vendors.md": destination };
    const head = {
      "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n",
      "CHANGELOG-vendors.md": `${destination}\n## [0.1.0] - 2026-01-01\n\n### Changed\n\n- rewritten\n`,
    };

    expect(missingReleasedHeadings(base, head)).toEqual([
      "CHANGELOG.md: ## [0.1.0] moved to CHANGELOG-vendors.md with altered content",
    ]);
    expect(relocatedReleasedSections(base, head)).toEqual([]);
  });
});
