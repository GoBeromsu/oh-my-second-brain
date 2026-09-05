#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repositoryRoot, "assets", "skills");
const destinationRoot = path.join(repositoryRoot, "skills");
const exportedSkills = ["distill", "doctor", "link", "search", "status", "template", "write"];

if (!existsSync(sourceRoot)) {
  console.error("[sync:skills] refusing to sync: assets/skills/ is missing.");
  process.exit(1);
}

const skillDirectories = readdirSync(sourceRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (JSON.stringify(skillDirectories) !== JSON.stringify(exportedSkills)) {
  console.error(`[sync:skills] refusing to sync: expected exactly ${exportedSkills.join(", ")}; found ${skillDirectories.join(", ") || "(none)"}.`);
  process.exit(1);
}

if (existsSync(destinationRoot)) rmSync(destinationRoot, { recursive: true, force: true });
mkdirSync(destinationRoot, { recursive: true });


for (const skillDirectory of skillDirectories) {
  const source = path.join(sourceRoot, skillDirectory);
  const destination = path.join(destinationRoot, skillDirectory);
  cpSync(source, destination, { recursive: true });
  const sourceSkill = readFileSync(path.join(source, "SKILL.md"));
  const destinationSkill = readFileSync(path.join(destination, "SKILL.md"));
  if (!sourceSkill.equals(destinationSkill)) {
    console.error(`[sync:skills] byte equality failed for ${skillDirectory}/SKILL.md.`);
    process.exit(1);
  }
}
