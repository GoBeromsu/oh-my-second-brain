#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const violations = [];
const excludedMarkdownFiles = new Set([
  // core/AGENTS.md is separately owned vault-convention SSOT; this gate only
  // validates user-facing repository and packaged host guidance.
  "core/AGENTS.md",
]);

// Archived execution records are snapshots of what was believed at the time.
// Forcing their links to stay live would either rewrite history or block CI
// forever, so the exclusion is a stated policy rather than a silent skip.
const excludedMarkdownPrefixes = ["docs/exec-plan/archived/"];

function isExcludedMarkdown(relativePath) {
  return (
    excludedMarkdownFiles.has(relativePath)
    || excludedMarkdownPrefixes.some((prefix) => relativePath.startsWith(prefix))
  );
}

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

function packagedFiles() {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const result = JSON.parse(output);
  if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0]?.files)) {
    throw new Error(`npm pack --dry-run --json returned an unexpected file manifest for ${root}.`);
  }
  return new Set(result[0].files.map((file) => file.path));
}

/**
 * Every Markdown document this repository is responsible for.
 *
 * The union of three sets, deduplicated:
 *   - live root Markdown
 *   - live `docs/**\/*.md`
 *   - every Markdown file in the npm pack manifest
 *
 * Deriving ONLY from the pack manifest was tried and was wrong: `files` ships
 * three documents out of `docs/`, so `AGENTS.md`, `CONTRIBUTING.md`, the ADRs
 * and most of `docs/` silently stopped being checked. Deriving only from the
 * live tree was also wrong: it missed shipped guidance under `assets/` and
 * `core/ontology/`. Coverage must be additive, because a document can be
 * repository-only, shipped-only, or both, and all three need checking.
 */
function documentedMarkdownFiles(packed) {
  const found = new Set();

  for (const file of packed) {
    if (file.endsWith(".md")) found.add(file);
  }
  for (const file of liveMarkdownFiles()) {
    found.add(file);
  }

  return [...found]
    .filter((file) => !isExcludedMarkdown(file))
    .sort()
    .map((file) => resolve(root, file));
}

/** Root-level and `docs/` Markdown present in the working tree. */
function liveMarkdownFiles() {
  const found = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) found.push(entry.name);
  }

  const walk = (relativeDir) => {
    let entries;
    try {
      entries = readdirSync(resolve(root, relativeDir), { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const relativePath = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) walk(relativePath);
      else if (entry.isFile() && entry.name.endsWith(".md")) found.push(relativePath);
    }
  };
  walk("docs");

  return found;
}

function isPackaged(path, files) {
  const relativePath = relative(root, path);
  return files.has(relativePath) || [...files].some((file) => file.startsWith(`${relativePath}/`));
}

/**
 * Does this document ship?
 *
 * Any packed Markdown file's relative references must resolve inside the
 * package, not merely inside the checkout. Restricting this to `assets/` let a
 * packed `README.md` link to an unpackaged file and pass, because the target
 * existed locally.
 */
function isPackagedGuidance(file, files) {
  return isPackaged(file, files);
}

function checkReference(file, line, target, packedFiles) {
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
  else if (isPackagedGuidance(file, packedFiles) && !isPackaged(candidate, packedFiles)) {
    violations.push(`${relative(root, file)}:${line}: unpackaged reference ${target}`);
  }
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function checkMarkdownLinks(file, text, packedFiles) {
  const link = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
  for (const match of text.matchAll(link)) {
    checkReference(file, lineNumber(text, match.index), match[1], packedFiles);
  }
}

function checkInlineSourcePaths(file, text, packedFiles) {
  // Inspect explicit paths rooted in this repository's live source topology,
  // in prose or code spans. This deliberately excludes unqualified `src/...`
  // citations in research notes, which commonly name another project's tree.
  const sourcePath = /\b((?:src|scripts|test|core|assets)(?:\/[A-Za-z0-9_.-]+)+\/?)/g;
  for (const match of text.matchAll(sourcePath)) {
    const candidate = resolve(root, match[1]);
    if (!existsSync(candidate)) report(file, lineNumber(text, match.index), match[1]);
    else if (isPackagedGuidance(file, packedFiles) && !isPackaged(candidate, packedFiles)) {
      violations.push(`${relative(root, file)}:${lineNumber(text, match.index)}: unpackaged reference ${match[1]}`);
    }
  }
}

function installedSkillNames() {
  const skills = resolve(root, "assets", "skills");
  if (!existsSync(skills)) return new Set();
  return new Set(
    readdirSync(skills, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
}

function checkHostSkillInvocations(file, text, skills) {
  const relativeFile = relative(root, file);
  if (relativeFile.startsWith("assets/codex/")) {
    for (const match of text.matchAll(/\$([a-z][a-z0-9-]*)\b/g)) {
      const name = match[1];
      if (!name.startsWith("oms-") || !skills.has(name.slice("oms-".length))) {
        violations.push(`${relativeFile}:${lineNumber(text, match.index)}: unknown Codex skill $${name}`);
      }
    }
  }
  if (relativeFile === "assets/claude/CLAUDE.md") {
    for (const match of text.matchAll(/`\/([a-z][a-z0-9-]*)\b[^`]*`/g)) {
      const name = match[1];
      if (!skills.has(name)) {
        violations.push(`${relativeFile}:${lineNumber(text, match.index)}: unknown Claude skill /${name}`);
      }
    }
  }
}

const packed = packagedFiles();
const files = documentedMarkdownFiles(packed);
assertNonVacuous(files, "user-facing documentation");
const skills = installedSkillNames();

for (const file of files) {
  const text = readFileSync(file, "utf8");
  checkMarkdownLinks(file, text, packed);
  checkHostSkillInvocations(file, text, skills);
  const relativeFile = relative(root, file);
  // Research notes and ADRs quote upstream or historical source topologies;
  // changelogs do the latter as release records; ACKNOWLEDGMENTS attributes
  // provenance by naming the source file a pattern came from. All four cite
  // source locations rather than asserting a path a reader should follow, so a
  // packaged-path check would be measuring the wrong thing.
  if (
    !relativeFile.startsWith("docs/research/")
    && !relativeFile.startsWith("docs/decisions/")
    && !relativeFile.startsWith("CHANGELOG")
    && relativeFile !== "ACKNOWLEDGMENTS.md"
  ) {
    checkInlineSourcePaths(file, text, packed);
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
}
