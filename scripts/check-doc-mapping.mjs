#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const violations = [];

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
  const sourcePath = /\b((?:src\/(?:assets|cli|kernel|mcp|vendors)|scripts|test|core|assets)(?:\/[A-Za-z0-9_.-]+)+\/?)/g;
  for (const match of text.matchAll(sourcePath)) {
    const candidate = resolve(root, match[1]);
    if (!existsSync(candidate)) report(file, lineNumber(text, match.index), match[1]);
  }
}

const files = [
  ...markdownFiles(root, false),
  ...markdownFiles(resolve(root, "docs"), true),
];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  checkMarkdownLinks(file, text);
  // Research notes quote paths from upstream projects; those are citations,
  // not assertions about this repository's tree.
  if (!relative(root, file).startsWith("docs/research/")) checkInlineSourcePaths(file, text);
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
}
