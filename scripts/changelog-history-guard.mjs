#!/usr/bin/env node
// Fails CI loudly if a previously-released changelog heading disappears
// between the base ref and the working tree. A missing base ref is a CI
// config failure (exit 2), never a silent pass.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { missingReleasedHeadings } from "./release-lib.mjs";

const CHANGELOG_FILES = [
  "CHANGELOG.md",
  "CHANGELOG-kernel.md",
  "CHANGELOG-cli.md",
  "CHANGELOG-mcp.md",
  "CHANGELOG-vendors.md",
  "CHANGELOG-assets.md",
];

function fail(message, code = 1) {
  console.error(`changelog-history-guard: ${message}`);
  process.exit(code);
}

const base = process.env.CHANGELOG_GUARD_BASE || "origin/main";

try {
  execFileSync("git", ["rev-parse", "--verify", base], { stdio: "pipe" });
} catch {
  fail(`base ref '${base}' does not exist or is not fetched.`, 2);
}

const baseContent = CHANGELOG_FILES.map((file) => {
  try {
    return execFileSync("git", ["show", `${base}:${file}`], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch {
    return "";
  }
}).join("\n");

const headContent = CHANGELOG_FILES.map((file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}).join("\n");

const missing = missingReleasedHeadings(baseContent, headContent);

if (missing.length > 0) {
  const message = `${missing.length} released heading(s) present at '${base}' are missing from the working tree changelogs:\n${missing.map((h) => `  - ${h}`).join("\n")}`;
  fail(message, 1);
}

console.log("changelog-history-guard: ok - no released headings were removed.");
process.exit(0);
