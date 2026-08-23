#!/usr/bin/env node
// Print the changelog section bodies for a version (used by release.yml for GitHub Release notes).
// Usage: node scripts/extract-release-notes.mjs <X.Y.Z>
import { readFileSync } from "node:fs";

import { extractReleaseNotes } from "./release-lib.mjs";

const CHANGELOG_FILES = [
  ["Aggregate", "CHANGELOG.md"],
  ["Kernel", "CHANGELOG-kernel.md"],
  ["CLI", "CHANGELOG-cli.md"],
  ["MCP", "CHANGELOG-mcp.md"],
  ["Vendors", "CHANGELOG-vendors.md"],
  ["Assets", "CHANGELOG-assets.md"],
];

const version = process.argv[2];
if (!version) {
  console.error("[extract-release-notes] usage: node scripts/extract-release-notes.mjs <X.Y.Z>");
  process.exit(1);
}

const sections = [];
for (const [layer, file] of CHANGELOG_FILES) {
  let content;
  try {
    content = readFileSync(file, "utf-8");
  } catch (error) {
    console.error(`[extract-release-notes] cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  try {
    const notes = extractReleaseNotes(content, version);
    sections.push(`## ${layer}\n\n${notes === "" ? "_No entries._" : notes}`);
  } catch (error) {
    if (error instanceof Error && error.message === `missing changelog section for version ${version}`) {
      sections.push(`## ${layer}\n\n_No entries._`);
      continue;
    }
    console.error(`[extract-release-notes] ${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (sections.every((section) => section.endsWith("_No entries._"))) {
  console.error(`[extract-release-notes] changelog section for ${version} is empty`);
  process.exit(1);
}

process.stdout.write(`${sections.join("\n\n")}\n`);
