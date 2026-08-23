#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const violations = [];

// Keep this failure mode aligned with test/architecture/repo-root.ts:
// a documentation gate that scans nothing is broken, not green.
function assertNonVacuous(files, what) {
  if (files.length === 0) {
    throw new Error(
      `architecture gate scanned zero files for "${what}". ` +
        "This means the gate is inspecting nothing and would pass vacuously. " +
        `Repository root resolved to ${root}.`,
    );
  }
}

function markdownFiles(directory, recursive) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    // Archived execution records are historical snapshots; validating their
    // old links would rewrite history or make current CI depend on it.
    if (entry.isDirectory() && relative(root, path) === "docs/exec-plan/archived") continue;
    if (entry.isDirectory() && recursive) files.push(...markdownFiles(path, true));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

function isRelativeTarget(target) {
  return target.length > 0
    && !target.startsWith("#")
    && !target.startsWith("/")
    && !target.startsWith("//")
    && !/^[a-z][a-z0-9+.-]*:/i.test(target);
}

function report(file, line, reference) {
  violations.push(`${relative(root, file)}:${line}: missing reference ${reference}`);
}

function checkReference(file, line, target) {
  const path = target.split(/[?#]/, 1)[0];
  if (!isRelativeTarget(path)) return;
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return;
  }
  const candidate = resolve(file, "..", decoded);
  if (!existsSync(candidate)) report(file, line, target);
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function checkMarkdownLinks(file, text) {
  const link = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
  for (const match of text.matchAll(link)) {
    checkReference(file, lineNumber(text, match.index), match[1]);
  }
}

function checkInlineSourcePaths(file, text) {
  // Inspect explicit paths rooted in this repository's live source topology,
  // in prose or code spans. This deliberately excludes unqualified `src/...`
  // citations in research notes, which commonly name another project's tree.
  const sourcePath = /\b((?:src|scripts|test|core|assets)(?:\/[A-Za-z0-9_.-]+)+\/?)/g;
  for (const match of text.matchAll(sourcePath)) {
    const candidate = resolve(root, match[1]);
    if (!existsSync(candidate)) report(file, lineNumber(text, match.index), match[1]);
  }
}

const files = [
  ...markdownFiles(root, false),
  ...markdownFiles(resolve(root, "docs"), true),
];
assertNonVacuous(files, "user-facing documentation");

for (const file of files) {
  const text = readFileSync(file, "utf8");
  checkMarkdownLinks(file, text);
  const relativeFile = relative(root, file);
  // Research notes and ADRs quote upstream or historical source topologies;
  // changelogs do the latter as release records. They are citations, not live
  // repository-path assertions.
  if (
    !relativeFile.startsWith("docs/research/")
    && !relativeFile.startsWith("docs/decisions/")
    && !relativeFile.startsWith("CHANGELOG")
  ) {
    checkInlineSourcePaths(file, text);
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
}
