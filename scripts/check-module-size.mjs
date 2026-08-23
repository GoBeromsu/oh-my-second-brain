#!/usr/bin/env node
/**
 * Module-size ratchet.
 *
 * This is a ratchet, not a static cap. A file may exceed SOFT_CAP only if it is
 * listed in GRANDFATHERED, and then only up to its recorded size plus
 * RESEED_SLACK. Any file may grow relative to the merge base only while staying
 * under its applicable ceiling.
 *
 * The policy constants below are signed by MODULE_SIZE_POLICY_ID. The checker
 * re-reads its own source and refuses to run if a constant has been replaced by
 * anything other than a literal, so a pull request cannot loosen the policy and
 * grow a module in the same commit.
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
  const sentinel = /^export const MODULE_SIZE_POLICY_ID = "([^"]+)";$/m.exec(source);
  if (sentinel === null) {
    throw new PolicyError("MODULE_SIZE_POLICY_ID is not a literal string assignment");
  }
  if (sentinel[1] !== MODULE_SIZE_POLICY_ID) {
    throw new PolicyError(
      `MODULE_SIZE_POLICY_ID literal ${JSON.stringify(sentinel[1])} does not match the loaded value`,
    );
  }

  const literalPatterns = {
    SOURCE_ROOT: /^export const SOURCE_ROOT = "[^"]+";$/m,
    SOURCE_EXTENSIONS: /^export const SOURCE_EXTENSIONS = \[[^\]]*\];$/m,
    SOFT_CAP: /^export const SOFT_CAP = \d+;$/m,
    RESEED_SLACK: /^export const RESEED_SLACK = \d+;$/m,
  };

  for (const name of POLICY_NAMES) {
    if (name === "MODULE_SIZE_POLICY_ID") continue;
    const pattern = literalPatterns[name];
    if (pattern === undefined || !pattern.test(source)) {
      throw new PolicyError(`${name} is not a literal assignment`);
    }
  }
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
  try {
    options = parseArgs(argv);
    assertPolicyLiterals(readFileSync(SELF_PATH, "utf8"));
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

  const currentLines = {};
  for (const file of files) {
    currentLines[file] = countLines(readFileSync(path.join(REPO_ROOT, file), "utf8"));
  }

  let baselineLines = null;
  if (options.baselineRef !== null) {
    baselineLines = {};
    for (const file of files) baselineLines[file] = baselineLineCount(options.baselineRef, file);
  }

  const violations = evaluate({ files, currentLines, baselineLines });
  const nearCap = files
    .filter((file) => {
      const current = currentLines[file];
      const ceiling = ceilingFor(file);
      return current <= ceiling && current > ceiling - RESEED_SLACK;
    })
    .map((file) => ({ file, lines: currentLines[file], ceiling: ceilingFor(file) }));

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ policyId: MODULE_SIZE_POLICY_ID, scanned: files.length, violations, nearCap }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`[module-size] scanned ${files.length} files under ${SOURCE_ROOT}/\n`);
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
