// Pure release helpers shared by scripts/*.mjs and test/release-lib.test.ts.
// No file I/O, no process.exit, no child_process: every function maps input to output.

const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const CHANGELOG_HEADER = "# Changelog";
/** Matches `# Changelog` and layer titles like `# Kernel Changelog` on line one. */
const CHANGELOG_HEADER_PATTERN = /^# (?:[A-Za-z][\w-]* )*Changelog\n/;
const UNRELEASED_HEADING = "## [Unreleased]";
const RELEASED_HEADING = /^(## \[(\d+\.\d+\.\d+)\](?: - .*)?)$/gm;

/**
 * @param {string} version
 * @returns {boolean} true when version is a stable X.Y.Z release (no prerelease/build metadata).
 */
export function isStableVersion(version) {
  return typeof version === "string" && STABLE_VERSION.test(version);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean} true when a is strictly greater than b comparing X.Y.Z numerically.
 */
export function isVersionGreater(a, b) {
  const left = versionSegments(a);
  const right = versionSegments(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

/**
 * @param {string} version
 * @returns {number[]}
 */
function versionSegments(version) {
  if (!isStableVersion(version)) {
    throw new Error(`invalid version: ${String(version)} (expected X.Y.Z)`);
  }
  return version.split(".").map((segment) => Number(segment));
}

/**
 * Roll `## [Unreleased]` into a dated release section, keeping released sections byte-identical.
 *
 * @param {string} content CHANGELOG.md text
 * @param {string} version release version (X.Y.Z)
 * @param {string} date release date (YYYY-MM-DD)
 * @param {{ allowEmpty?: boolean }} [options] allowEmpty inserts an empty release section instead of throwing
 * @returns {string} rolled changelog text
 */
export function rolledChangelog(content, version, date, options = {}) {
  const allowEmpty = options.allowEmpty === true;
  // The aggregate is titled `# Changelog`; each layer file carries a
  // descriptive title such as `# Kernel Changelog`. Requiring the aggregate's
  // exact wording meant no layer file could ever be rolled, so the five-layer
  // split shipped with a release path that aborted on the first layer it read.
  // The guard still earns its place: line one must be a level-one heading that
  // names the file as a changelog, which is what distinguishes a changelog from
  // whatever else a path might point at.
  if (typeof content !== "string" || !CHANGELOG_HEADER_PATTERN.test(content)) {
    throw new Error(
      `malformed changelog: first line must be a level-one heading ending in 'Changelog' (for example '${CHANGELOG_HEADER}' or '# Kernel Changelog')`,
    );
  }
  const duplicates = duplicateChangelogHeadings(content);
  if (duplicates.length > 0) {
    throw new Error(`malformed changelog: duplicate heading(s): ${duplicates.join(", ")}`);
  }
  const unreleasedStart = content.indexOf(`\n${UNRELEASED_HEADING}`);
  if (unreleasedStart === -1) {
    throw new Error(`malformed changelog: missing '${UNRELEASED_HEADING}' section`);
  }

  const headingEnd = content.indexOf("\n", unreleasedStart + 1);
  const bodyStart = headingEnd === -1 ? content.length : headingEnd + 1;
  const nextSection = content.indexOf("\n## [", bodyStart - 1);
  const bodyEnd = nextSection === -1 ? content.length : nextSection + 1;
  const prefix = content.slice(0, unreleasedStart + 1);
  const body = content.slice(bodyStart, bodyEnd);
  const rest = content.slice(bodyEnd);
  const releaseHeading = `## [${version}] - ${date}`;

  if (body.trim() === "") {
    if (!allowEmpty) {
      throw new Error("empty [Unreleased] - write release notes before releasing");
    }
    return `${prefix}${UNRELEASED_HEADING}\n\n${releaseHeading}\n\n${rest}`;
  }

  return `${prefix}${UNRELEASED_HEADING}\n\n${releaseHeading}\n${body}${rest}`;
}

/**
 * @param {string} content CHANGELOG.md text
 * @param {string} version release version (X.Y.Z)
 * @returns {string} trimmed body of the release section
 */
export function extractReleaseNotes(content, version) {
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\] - .*$`, "m");
  const match = heading.exec(content ?? "");
  if (!match) {
    throw new Error(`missing changelog section for version ${version}`);
  }
  const bodyStart = match.index + match[0].length;
  const nextSection = content.indexOf("\n## [", bodyStart);
  const body = nextSection === -1 ? content.slice(bodyStart) : content.slice(bodyStart, nextSection);
  return body.trim();
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace only the first `"version": "..."` pair, preserving all other formatting.
 *
 * @param {string} jsonText
 * @param {string} version
 * @returns {string}
 */
export function bumpedJsonVersion(jsonText, version) {
  if (!isStableVersion(version)) {
    throw new Error(`invalid version: ${String(version)} (expected X.Y.Z)`);
  }
  const pattern = /"version"(\s*:\s*)"[^"]*"/;
  if (!pattern.test(jsonText ?? "")) {
    throw new Error('malformed json: no "version" field found');
  }
  return jsonText.replace(pattern, (_match, separator) => `"version"${separator}"${version}"`);
}

/**
 * Set both package-lock version carriers (root and packages[""]).
 *
 * @param {string} jsonText
 * @param {string} version
 * @returns {string} re-stringified lockfile with 2-space indent and trailing newline
 */
export function bumpedPackageLock(jsonText, version) {
  if (!isStableVersion(version)) {
    throw new Error(`invalid version: ${String(version)} (expected X.Y.Z)`);
  }
  const lock = JSON.parse(jsonText);
  if (!lock || typeof lock !== "object" || !lock.packages || typeof lock.packages !== "object" || !lock.packages[""]) {
    throw new Error('malformed package-lock: missing packages[""] entry');
  }
  lock.version = version;
  lock.packages[""].version = version;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/**
 * Set both marketplace version carriers (top-level and plugins[0]).
 *
 * The marketplace manifest is the only carrier holding the version twice, so a
 * text replace of the first `"version"` pair (bumpedJsonVersion) would leave the
 * other one stale. Parse-and-set, exactly like bumpedPackageLock.
 *
 * @param {string} jsonText
 * @param {string} version
 * @returns {string} re-stringified manifest with 2-space indent and trailing newline
 */
export function bumpedMarketplace(jsonText, version) {
  if (!isStableVersion(version)) {
    throw new Error(`invalid version: ${String(version)} (expected X.Y.Z)`);
  }
  const marketplace = JSON.parse(jsonText);
  const plugin = marketplace?.plugins?.[0];
  if (!plugin || typeof plugin !== "object") {
    throw new Error("malformed marketplace: missing plugins[0] entry");
  }
  marketplace.version = version;
  plugin.version = version;
  return `${JSON.stringify(marketplace, null, 2)}\n`;
}

/**
 * @param {{
 *   version: string,
 *   packageJson: { version?: string },
 *   packageLock: { version?: string, packages?: Record<string, { version?: string }> },
 *   claudePluginJson: { version?: string },
 *   codexPluginJson: { version?: string },
 *   hermesManifestJson: { version?: string },
 *   marketplaceJson: { version?: string, plugins?: { version?: string }[] },
 * }} carriers
 * @returns {string[]} human-readable mismatch descriptions; empty when every carrier matches
 */
export function versionMismatches({
  version,
  packageJson,
  packageLock,
  claudePluginJson,
  codexPluginJson,
  hermesManifestJson,
  marketplaceJson,
}) {
  const checks = [
    ["package.json", packageJson?.version],
    ["package-lock.json", packageLock?.version],
    ['package-lock.json packages[""]', packageLock?.packages?.[""]?.version],
    [".claude-plugin/plugin.json", claudePluginJson?.version],
    [".codex-plugin/plugin.json", codexPluginJson?.version],
    ["assets/hermes-manifest.json", hermesManifestJson?.version],
    [".claude-plugin/marketplace.json", marketplaceJson?.version],
    ['.claude-plugin/marketplace.json plugins[0]', marketplaceJson?.plugins?.[0]?.version],
  ];
  return checks
    .filter(([, actual]) => actual !== version)
    .map(([name, actual]) => `${name}=${actual === undefined ? "missing" : actual} (expected ${version})`);
}

/**
 * Return duplicate top-level changelog headings. Release versions and
 * [Unreleased] each have exactly one authoritative section.
 *
 * @param {string} content
 * @returns {string[]} duplicate headings, once each, in document order
 */
export function duplicateChangelogHeadings(content) {
  const duplicates = [];
  const seen = new Set();
  const lines = (content ?? "").split("\n");

  for (const line of lines) {
    const released = /^## \[(\d+\.\d+\.\d+)\](?: - .*)?$/.exec(line);
    const heading = released ? `## [${released[1]}]` : line === UNRELEASED_HEADING ? UNRELEASED_HEADING : null;
    if (heading === null) continue;
    if (seen.has(heading)) {
      if (!duplicates.includes(heading)) duplicates.push(heading);
    } else {
      seen.add(heading);
    }
  }
  return duplicates;
}

/**
 * @param {Record<string, string>} baseChangelogs changelog text by file at the merge base
 * @param {Record<string, string>} headChangelogs changelog text by file at HEAD
 * @returns {string[]} file-qualified released headings present in base but absent in the same file at head
 */
export function missingReleasedHeadings(baseChangelogs, headChangelogs) {
  const missing = [];
  for (const [file, baseContent] of Object.entries(baseChangelogs)) {
    const baseSections = releasedSections(baseContent);
    const headHeadings = new Set(releasedHeadings(headChangelogs[file] ?? ""));
    for (const [heading, body] of baseSections) {
      if (headHeadings.has(heading)) continue;
      const destination = relocatedSection(file, heading, body, baseChangelogs, headChangelogs);
      if (destination === null) {
        missing.push(`${file}: ${heading}`);
      } else if (!destination.identical) {
        missing.push(`${file}: ${heading} moved to ${destination.file} with altered content`);
      }
    }
  }
  return missing;
}

/**
 * Return released sections moved to a changelog that did not hold that version
 * at base, preserving their content byte-for-byte (apart from trailing space).
 *
 * @param {Record<string, string>} baseChangelogs changelog text by file at the merge base
 * @param {Record<string, string>} headChangelogs changelog text by file at HEAD
 * @returns {{ fromFile: string, toFile: string, heading: string }[]}
 */
export function relocatedReleasedSections(baseChangelogs, headChangelogs) {
  const relocations = [];
  for (const [file, baseContent] of Object.entries(baseChangelogs)) {
    const head = releasedSections(headChangelogs[file] ?? "");
    for (const [heading, body] of releasedSections(baseContent)) {
      if (head.has(heading)) continue;
      const destination = relocatedSection(file, heading, body, baseChangelogs, headChangelogs);
      if (destination?.identical) relocations.push({ fromFile: file, toFile: destination.file, heading });
    }
  }
  return relocations;
}

/**
 * @param {string} sourceFile
 * @param {string} heading
 * @param {string} body
 * @param {Record<string, string>} baseChangelogs
 * @param {Record<string, string>} headChangelogs
 * @returns {{ file: string, identical: boolean } | null}
 */
function relocatedSection(sourceFile, heading, body, baseChangelogs, headChangelogs) {
  const normalise = (text) => text.replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
  for (const [file, headContent] of Object.entries(headChangelogs)) {
    if (file === sourceFile) continue;
    const destinationBody = releasedSections(headContent).get(heading);
    if (destinationBody === undefined) continue;
    // A duplicate that already existed at base is not a move. This distinction
    // keeps deleting one of six same-version layer sections from being masked.
    if (releasedSections(baseChangelogs[file] ?? "").has(heading)) continue;
    return { file, identical: normalise(body) === normalise(destinationBody) };
  }
  return null;
}

/**
 * Split a changelog into released sections keyed by version heading.
 *
 * A section runs from its full `## [X.Y.Z] - date` heading to the next `## `
 * heading. Nested headings belong to that section.
 *
 * @param {string} content
 * @returns {Map<string, string>}
 */
function releasedSections(content) {
  const sections = new Map();
  const lines = (content ?? "").split("\n");
  const headingPattern = new RegExp(RELEASED_HEADING.source);

  let current = null;
  let buffer = [];
  for (const line of lines) {
    const match = headingPattern.exec(line);
    if (match !== null) {
      if (current !== null) sections.set(current, buffer.join("\n"));
      current = `## [${match[2]}]`;
      buffer = [match[1]];
      continue;
    }
    if (/^## /.test(line)) {
      if (current !== null) sections.set(current, buffer.join("\n"));
      current = null;
      buffer = [];
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  if (current !== null) sections.set(current, buffer.join("\n"));
  return sections;
}

/**
 * Released sections whose CONTENT changed between base and head.
 *
 * Comparing heading sets alone lets a released section's entire body be
 * rewritten as long as its heading survives, which is exactly the mutation the
 * immutability rule exists to prevent. Normalises trailing whitespace so a
 * formatter cannot trip the guard on a no-op change.
 *
 * @param {Record<string, string>} baseChangelogs changelog text by file at the merge base
 * @param {Record<string, string>} headChangelogs changelog text by file at HEAD
 * @returns {string[]} file-qualified headings whose section content differs
 */
export function alteredReleasedSections(baseChangelogs, headChangelogs) {
  const normalise = (text) => text.replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
  const altered = [];

  for (const [file, baseContent] of Object.entries(baseChangelogs)) {
    const head = releasedSections(headChangelogs[file] ?? "");
    for (const [heading, body] of releasedSections(baseContent)) {
      const headBody = head.get(heading);
      // A heading that disappeared is reported by missingReleasedHeadings.
      if (headBody === undefined) continue;
      if (normalise(body) !== normalise(headBody)) altered.push(`${file}: ${heading}`);
    }
  }
  return altered;
}

/**
 * @param {string} content
 * @returns {string[]} `## [X.Y.Z]` headings in document order (never `## [Unreleased]`)
 */
function releasedHeadings(content) {
  const headings = [];
  const pattern = new RegExp(RELEASED_HEADING.source, RELEASED_HEADING.flags);
  let match = pattern.exec(content ?? "");
  while (match !== null) {
    headings.push(`## [${match[2]}]`);
    match = pattern.exec(content);
  }
  return headings;
}
