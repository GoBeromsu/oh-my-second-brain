#!/usr/bin/env node
// Print the CHANGELOG.md section body for a version (used by release.yml for GitHub Release notes).
// Usage: node scripts/extract-release-notes.mjs <X.Y.Z>
import { readFileSync } from "node:fs";

import { extractReleaseNotes } from "./release-lib.mjs";

const version = process.argv[2];
if (!version) {
  console.error("[extract-release-notes] usage: node scripts/extract-release-notes.mjs <X.Y.Z>");
  process.exit(1);
}

let content;
try {
  content = readFileSync("CHANGELOG.md", "utf-8");
} catch (error) {
  console.error(`[extract-release-notes] cannot read CHANGELOG.md: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

let notes;
try {
  notes = extractReleaseNotes(content, version);
} catch (error) {
  console.error(`[extract-release-notes] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (notes === "") {
  console.error(`[extract-release-notes] changelog section for ${version} is empty`);
  process.exit(1);
}

process.stdout.write(`${notes}\n`);
