#!/usr/bin/env node

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repositoryRoot, "assets", "skills");
const destinationRoot = path.join(repositoryRoot, "skills");
const exportedSkills = ["distill", "doctor", "link", "search", "setup", "status", "write"];
const skillNamePattern = /^[a-z][a-z0-9-]*$/u;
const ownedSkillFile = "SKILL.md";

/**
 * Repeatable `--skill <name>` (or `--skill=<name>`) regenerates only that
 * authored skill's SKILL.md. With no `--skill`, every allowlisted skill's
 * SKILL.md is regenerated. Names are validated against the authored source
 * before any write. Only `<skill>/SKILL.md` is written: skill directories are
 * never deleted, and files beside SKILL.md are left untouched.
 */
export function parseSkillSelection(args) {
  const selected = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      if (index !== args.length - 1) refuse(`unexpected argument ${args[index + 1]}.`);
      break;
    }
    if (arg === "--skill") {
      const name = args[index + 1];
      if (name === undefined || name.startsWith("-")) refuse("--skill requires an authored skill name.");
      selected.push(name);
      index += 1;
      continue;
    }
    if (arg.startsWith("--skill=")) {
      const name = arg.slice("--skill=".length);
      if (name.length === 0) refuse("--skill requires an authored skill name.");
      selected.push(name);
      continue;
    }
    refuse(`unexpected argument ${arg}.`);
  }

  const seen = new Set();
  for (const name of selected) {
    if (seen.has(name)) refuse(`repeated skill selection ${name}.`);
    seen.add(name);
    if (!skillNamePattern.test(name) || name.includes("..") || name.includes("/") || name.includes("\\")) {
      refuse(`invalid skill name ${name}.`);
    }
  }
  return selected;
}

export function authoredSkillDirectories(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

export function resolveSkillSelection(authored, selected) {
  if (JSON.stringify(authored) !== JSON.stringify(exportedSkills)) {
    refuse(`expected exactly ${exportedSkills.join(", ")}; found ${authored.join(", ") || "(none)"}.`);
  }
  if (selected.length === 0) return authored;
  const authoredSet = new Set(authored);
  const unknown = selected.filter((name) => !authoredSet.has(name));
  if (unknown.length > 0) {
    refuse(`unknown skill ${unknown.join(", ")}; authored skills are ${authored.join(", ")}.`);
  }
  return selected;
}

function refuse(message) {
  throw new Error(`[sync:skills] refusing to sync: ${message}`);
}

function lstatIfExists(target) {
  return lstatSync(target, { throwIfNoEntry: false });
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalPath(target) {
  const resolved = path.resolve(target);
  const missing = [];
  let current = resolved;
  while (!lstatIfExists(current)) {
    const parent = path.dirname(current);
    if (parent === current) refuse(`cannot resolve ${target}.`);
    missing.push(path.basename(current));
    current = parent;
  }
  let real;
  try {
    real = realpathSync(current);
  } catch {
    refuse(`cannot resolve ${target}.`);
  }
  missing.reverse();
  return missing.length === 0 ? real : path.join(real, ...missing);
}

function assertDisjointRoots(source, destination) {
  const resolvedSource = path.resolve(source);
  const resolvedDestination = path.resolve(destination);
  if (isInside(resolvedSource, resolvedDestination) || isInside(resolvedDestination, resolvedSource)) {
    refuse("source and destination overlap.");
  }
  const realSource = canonicalPath(source);
  const realDestination = canonicalPath(destination);
  if (realSource !== resolvedSource || realDestination !== resolvedDestination) {
    if (realSource === realDestination || isInside(realSource, realDestination) || isInside(realDestination, realSource)) {
      refuse("source and destination overlap.");
    }
  }
}

function ownedFilePath(root, skill) {
  const file = path.join(root, skill, ownedSkillFile);
  if (path.relative(root, file) !== path.join(skill, ownedSkillFile)) refuse(`skill ${skill} escapes its root.`);
  return file;
}

function assertCreatableDirectory(target) {
  const resolved = path.resolve(target);
  let current = resolved;
  for (;;) {
    const stat = lstatIfExists(current);
    if (stat) {
      if (current === resolved) refuse("destination is not a real directory.");
      if (stat.isSymbolicLink()) {
        const realStat = lstatSync(realpathSync(current));
        if (realStat.isSymbolicLink() || !realStat.isDirectory()) refuse("destination parent is not a real directory.");
        return;
      }
      if (!stat.isDirectory()) refuse("destination parent is not a real directory.");
      return;
    }
    const parent = path.dirname(current);
    if (parent === current) refuse("destination parent is not a real directory.");
    current = parent;
  }
}

function assertRealDirectory(target, label) {
  const stat = lstatIfExists(target);
  if (!stat) return null;
  if (stat.isSymbolicLink()) refuse(`${label} is a symlink.`);
  if (!stat.isDirectory()) refuse(`${label} is not a real directory.`);
  return stat;
}

function preflightOwnedSkill(source, destination, skill) {
  const sourceDir = path.join(source, skill);
  if (!assertRealDirectory(sourceDir, `source ${skill}`)) refuse(`source ${skill} is not a real directory.`);
  const from = ownedFilePath(source, skill);
  const sourceStat = lstatIfExists(from);
  if (!sourceStat) refuse(`missing source ${skill}/SKILL.md.`);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) refuse(`source ${skill}/SKILL.md is not a regular file.`);
  if (!isInside(canonicalPath(source), canonicalPath(from))) refuse(`source ${skill}/SKILL.md escapes the authored root.`);

  const destinationStat = lstatIfExists(destination);
  if (!destinationStat) assertCreatableDirectory(destination);
  else assertRealDirectory(destination, "destination");

  const skillDir = path.join(destination, skill);
  const destinationDirStat = lstatIfExists(skillDir);
  if (destinationDirStat) assertRealDirectory(skillDir, `destination ${skill}`);

  const to = ownedFilePath(destination, skill);
  const destinationFileStat = lstatIfExists(to);
  if (destinationFileStat?.isSymbolicLink()) refuse(`destination ${skill}/SKILL.md is a symlink.`);
  if (!isInside(canonicalPath(destination), canonicalPath(to))) refuse(`destination ${skill}/SKILL.md escapes the destination.`);
  if (destinationFileStat) {
    if (destinationFileStat.isSymbolicLink()) refuse(`destination ${skill}/SKILL.md is a symlink.`);
    if (!destinationFileStat.isFile()) refuse(`destination ${skill}/SKILL.md is not a regular file.`);
    if (destinationFileStat.nlink > 1 || (destinationFileStat.dev === sourceStat.dev && destinationFileStat.ino === sourceStat.ino)) {
      refuse(`destination ${skill}/SKILL.md is a hardlink.`);
    }
  }
  return { skill, from, to, bytes: readFileSync(from) };
}

function ensureRealSkillDirectory(skill, skillDir) {
  const existing = lstatIfExists(skillDir);
  if (!existing) mkdirSync(skillDir, { recursive: true });
  const stat = lstatSync(skillDir);
  if (stat.isSymbolicLink()) refuse(`destination ${skill} is a symlink.`);
  if (!stat.isDirectory()) refuse(`destination ${skill} is not a real directory.`);
}

function writeOwnedFile(skill, target, bytes) {
  const existing = lstatIfExists(target);
  if (existing?.isSymbolicLink()) refuse(`destination ${skill}/SKILL.md is a symlink.`);
  if (existing && (!existing.isFile() || existing.nlink > 1)) refuse(`destination ${skill}/SKILL.md is a hardlink.`);
  const flags = existing
    ? constants.O_WRONLY | constants.O_NOFOLLOW
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  let fd;
  try {
    fd = openSync(target, flags, 0o644);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "ELOOP" || error.code === "EEXIST")) {
      refuse(`destination ${skill}/SKILL.md is a symlink.`);
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1) refuse(`destination ${skill}/SKILL.md is a hardlink.`);
    ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  } finally {
    closeSync(fd);
  }
}

export function syncSelectedSkills({ sourceRoot: source, destinationRoot: destination, skills }) {
  assertDisjointRoots(source, destination);
  const plan = skills.map((skill) => preflightOwnedSkill(source, destination, skill));
  for (const item of plan) {
    ensureRealSkillDirectory(item.skill, path.dirname(item.to));
    writeOwnedFile(item.skill, item.to, item.bytes);
    const writtenStat = lstatSync(item.to);
    if (writtenStat.isSymbolicLink() || !writtenStat.isFile() || writtenStat.nlink > 1 || !readFileSync(item.to).equals(item.bytes)) {
      throw new Error(`[sync:skills] byte equality failed for ${item.skill}/SKILL.md.`);
    }
  }
  return skills;
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

export function main(args, roots = { sourceRoot, destinationRoot }) {
  if (!existsSync(roots.sourceRoot)) refuse("assets/skills/ is missing.");
  const selected = parseSkillSelection(args);
  const skills = resolveSkillSelection(authoredSkillDirectories(roots.sourceRoot), selected);
  return syncSelectedSkills({ ...roots, skills });
}

if (isDirectRun()) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
