#!/usr/bin/env node
/**
 * Module-size ratchet.
 *
 * This is a ratchet, not a static cap. A file may exceed SOFT_CAP only if it is
 * listed in GRANDFATHERED, and then only up to its recorded size plus
 * RESEED_SLACK. Any file may grow relative to the merge base only while staying
 * under its applicable ceiling.
 *
 * The policy constants below are compared with the version at the merge base.
 * The checker also refuses to run if a constant has been replaced by anything
 * other than a literal, so policy changes remain reviewable.
 *
 * Usage:
 *   node scripts/check-module-size.mjs [--baseline-ref <git-ref>] [--json]
 *
 * Exit codes: 0 pass, 1 violation, 2 policy/usage error.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MODULE_SIZE_POLICY_ID = "oms.module-size.v1";
export const SOURCE_ROOT = "src";
export const SOURCE_EXTENSIONS = [".ts"];
export const SOFT_CAP = 2000;
export const RESEED_SLACK = 200;

/**
 * Files already over SOFT_CAP when the ratchet was introduced, with the line
 * count at that moment. Empty on purpose: no file in src/ exceeded 2000 lines
 * when this gate landed, so every file is held to SOFT_CAP from day one.
 */
export const GRANDFATHERED = Object.freeze({});

/** Generated or vendored files that carry no review cost. */
export const EXCLUDED = Object.freeze([]);

const POLICY_NAMES = [
  "MODULE_SIZE_POLICY_ID",
  "SOURCE_ROOT",
  "SOURCE_EXTENSIONS",
  "SOFT_CAP",
  "RESEED_SLACK",
  "GRANDFATHERED",
  "EXCLUDED",
];

const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), "..");

class PolicyError extends Error {}

/**
 * Refuse to run when a policy constant is not a plain literal.
 *
 * Without this, a pull request could swap `SOFT_CAP = 2000` for a computed or
 * environment-derived value and grow a module past the ceiling in the same
 * commit, with the gate reporting green.
 */
export function assertPolicyLiterals(source) {
  const literalPatterns = {
    MODULE_SIZE_POLICY_ID: /^export const MODULE_SIZE_POLICY_ID = "[^"]+";$/m,
    SOURCE_ROOT: /^export const SOURCE_ROOT = "[^"]+";$/m,
    SOURCE_EXTENSIONS: /^export const SOURCE_EXTENSIONS = \[[^\]]*\];$/m,
    SOFT_CAP: /^export const SOFT_CAP = \d+;$/m,
    RESEED_SLACK: /^export const RESEED_SLACK = \d+;$/m,
    GRANDFATHERED: /^export const GRANDFATHERED = Object\.freeze\(\{[^\n]*\}\);$/m,
    EXCLUDED: /^export const EXCLUDED = Object\.freeze\(\[[^\]]*\]\);$/m,
  };

  for (const name of POLICY_NAMES) {
    const pattern = literalPatterns[name];
    if (pattern === undefined || !pattern.test(source)) {
      throw new PolicyError(`${name} is not a literal assignment`);
    }
  }
}

function literalValue(source, name) {
  const match = new RegExp(`^export const ${name} = (.+);$`, "m").exec(source);
  if (match === null) throw new PolicyError(`${name} is missing`);
  return match[1];
}

function jsonLiteralValue(source, name) {
  try {
    return JSON.parse(literalValue(source, name));
  } catch {
    throw new PolicyError(`${name} is not valid JSON`);
  }
}

function frozenJsonLiteralValue(source, name) {
  const value = literalValue(source, name);
  const match = /^Object\.freeze\((.+)\)$/.exec(value);
  if (match === null) throw new PolicyError(`${name} is not a frozen literal`);
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new PolicyError(`${name} is not valid JSON`);
  }
}

function policyValues(source) {
  const sourceExtensions = jsonLiteralValue(source, "SOURCE_EXTENSIONS");
  const grandfathered = frozenJsonLiteralValue(source, "GRANDFATHERED");
  const excluded = frozenJsonLiteralValue(source, "EXCLUDED");
  if (!Array.isArray(sourceExtensions) || !sourceExtensions.every((value) => typeof value === "string")) {
    throw new PolicyError("SOURCE_EXTENSIONS must be an array of strings");
  }
  if (!Array.isArray(excluded) || !excluded.every((value) => typeof value === "string")) {
    throw new PolicyError("EXCLUDED must be an array of strings");
  }
  if (
    grandfathered === null ||
    Array.isArray(grandfathered) ||
    typeof grandfathered !== "object" ||
    !Object.values(grandfathered).every((value) => Number.isSafeInteger(value) && value >= 0)
  ) {
    throw new PolicyError("GRANDFATHERED must map paths to non-negative integer line counts");
  }
  return {
    policyId: jsonLiteralValue(source, "MODULE_SIZE_POLICY_ID"),
    sourceRoot: jsonLiteralValue(source, "SOURCE_ROOT"),
    sourceExtensions,
    softCap: Number(literalValue(source, "SOFT_CAP")),
    reseedSlack: Number(literalValue(source, "RESEED_SLACK")),
    grandfathered,
    excluded,
  };
}

/**
 * Compare the policy literals from a trusted baseline source to the current
 * source. This is pure so tests can model a pull request changing both a cap
 * and its policy ID in one commit.
 */
export function comparePolicySources(baselineSource, currentSource) {
  assertPolicyLiterals(baselineSource);
  assertPolicyLiterals(currentSource);

  const baseline = policyValues(baselineSource);
  const current = policyValues(currentSource);
  const violations = [];

  if (current.policyId !== baseline.policyId) {
    violations.push(`MODULE_SIZE_POLICY_ID changed from ${JSON.stringify(baseline.policyId)} to ${JSON.stringify(current.policyId)}`);
  }
  if (current.sourceRoot !== baseline.sourceRoot) {
    violations.push(`SOURCE_ROOT changed from ${JSON.stringify(baseline.sourceRoot)} to ${JSON.stringify(current.sourceRoot)}`);
  }
  if (current.softCap > baseline.softCap) {
    violations.push(`SOFT_CAP rose from ${baseline.softCap} to ${current.softCap}`);
  }
  if (current.reseedSlack > baseline.reseedSlack) {
    violations.push(`RESEED_SLACK rose from ${baseline.reseedSlack} to ${current.reseedSlack}`);
  }
  for (const extension of baseline.sourceExtensions) {
    if (!current.sourceExtensions.includes(extension)) {
      violations.push(`SOURCE_EXTENSIONS removed ${JSON.stringify(extension)}`);
    }
  }
  for (const file of current.excluded) {
    if (!baseline.excluded.includes(file)) {
      violations.push(`EXCLUDED added ${JSON.stringify(file)}`);
    }
  }
  for (const [file, size] of Object.entries(current.grandfathered)) {
    const baselineSize = baseline.grandfathered[file];
    if (baselineSize === undefined) {
      violations.push(`GRANDFATHERED added ${JSON.stringify(file)} at ${size}`);
    } else if (size > baselineSize) {
      violations.push(`GRANDFATHERED ${JSON.stringify(file)} rose from ${baselineSize} to ${size}`);
    }
  }

  return violations;
}

/** Ceiling for a given file: its grandfathered size plus slack, else SOFT_CAP. */
export function ceilingFor(relativePath) {
  const recorded = GRANDFATHERED[relativePath];
  return recorded === undefined ? SOFT_CAP : recorded + RESEED_SLACK;
}

export function countLines(contents) {
  if (contents === "") return 0;
  const lines = contents.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function isSourceFile(relativePath) {
  if (EXCLUDED.includes(relativePath)) return false;
  if (relativePath.endsWith(".test.ts")) return false;
  return SOURCE_EXTENSIONS.some((extension) => relativePath.endsWith(extension));
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function trackedSourceFiles() {
  return git(["ls-files", SOURCE_ROOT])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && isSourceFile(line))
    .sort();
}

function baselineLineCount(baselineRef, relativePath) {
  try {
    return countLines(git(["show", `${baselineRef}:${relativePath}`]));
  } catch {
    return null; // new file at this ref
  }
}

function baselinePolicySource(baselineRef) {
  try {
    return git(["show", `${baselineRef}:scripts/check-module-size.mjs`]);
  } catch {
    return null;
  }
}

export function evaluate({ files, currentLines, baselineLines }) {
  const violations = [];
  for (const file of files) {
    const current = currentLines[file];
    if (current === undefined) continue;
    const ceiling = ceilingFor(file);

    if (current > ceiling) {
      violations.push({
        file,
        kind: "over-ceiling",
        current,
        ceiling,
        message: `${file} is ${current} lines, ceiling is ${ceiling}`,
      });
      continue;
    }

    const baseline = baselineLines?.[file];
    if (baseline !== undefined && baseline !== null && current > baseline && baseline > ceiling) {
      violations.push({
        file,
        kind: "grew-over-ceiling",
        current,
        ceiling,
        baseline,
        message: `${file} grew ${baseline} -> ${current} while already over its ${ceiling} ceiling`,
      });
    }
  }
  return violations;
}

function parseArgs(argv) {
  const options = { baselineRef: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--baseline-ref") {
      const value = argv[index + 1];
      if (value === undefined) throw new PolicyError("--baseline-ref requires a value");
      options.baselineRef = value;
      index += 1;
    } else throw new PolicyError(`unknown argument: ${arg}`);
  }
  return options;
}

function main(argv) {
  let options;
  let currentPolicySource;
  try {
    options = parseArgs(argv);
    currentPolicySource = readFileSync(SELF_PATH, "utf8");
    assertPolicyLiterals(currentPolicySource);
  } catch (error) {
    process.stderr.write(`[module-size] policy error: ${error.message}\n`);
    return 2;
  }

  const files = trackedSourceFiles();
  if (files.length === 0) {
    process.stderr.write(
      `[module-size] scanned zero files under ${SOURCE_ROOT}/. Refusing to pass vacuously.\n`,
    );
    return 2;
  }

  // `git ls-files` reports tracked paths, which during a rename still includes
  // files already removed from disk. Skip those rather than crashing: a checker
  // that dies on a mid-rename tree cannot be run while doing the work it exists
  // to police.
  const currentLines = {};
  const present = [];
  for (const file of files) {
    let contents;
    try {
      contents = readFileSync(path.join(REPO_ROOT, file), "utf8");
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    currentLines[file] = countLines(contents);
    present.push(file);
  }

  if (present.length === 0) {
    process.stderr.write(
      `[module-size] every tracked file under ${SOURCE_ROOT}/ is missing from disk. Refusing to pass vacuously.\n`,
    );
    return 2;
  }

  let baselineLines = null;
  let policyViolations = [];
  let baselineStatus = "unavailable";
  if (options.baselineRef !== null) {
    const baselineSource = baselinePolicySource(options.baselineRef);
    if (baselineSource === null) {
      process.stderr.write(
        `[module-size] warning: baseline ${options.baselineRef} cannot provide scripts/check-module-size.mjs; policy comparison was skipped.\n`,
      );
    } else {
      try {
        baselineLines = {};
        for (const file of files) baselineLines[file] = baselineLineCount(options.baselineRef, file);
        policyViolations = comparePolicySources(baselineSource, currentPolicySource);
        baselineStatus = "compared";
      } catch (error) {
        process.stderr.write(`[module-size] policy error: baseline ${options.baselineRef}: ${error.message}\n`);
        return 2;
      }
    }
  } else {
    process.stderr.write(
      "[module-size] warning: no baseline ref supplied; policy comparison was skipped.\n",
    );
  }

  const violations = [
    ...policyViolations.map((message) => ({ kind: "policy-loosened", message })),
    ...evaluate({ files: present, currentLines, baselineLines }),
  ];
  const nearCap = present
    .filter((file) => {
      const current = currentLines[file];
      const ceiling = ceilingFor(file);
      return current <= ceiling && current > ceiling - RESEED_SLACK;
    })
    .map((file) => ({ file, lines: currentLines[file], ceiling: ceilingFor(file) }));

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ policyId: MODULE_SIZE_POLICY_ID, baselineStatus, scanned: present.length, violations, nearCap }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`[module-size] scanned ${present.length} files under ${SOURCE_ROOT}/\n`);
    for (const entry of nearCap) {
      process.stdout.write(
        `[module-size] warning: ${entry.file} is ${entry.lines} lines, within ${RESEED_SLACK} of its ${entry.ceiling} ceiling\n`,
      );
    }
    for (const violation of violations) process.stderr.write(`[module-size] ${violation.message}\n`);
    if (violations.length === 0) process.stdout.write("[module-size] ok\n");
  }

  return violations.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SELF_PATH) {
  process.exit(main(process.argv.slice(2)));
}
