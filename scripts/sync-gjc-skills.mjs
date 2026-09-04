#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repositoryRoot, "assets", "skills");
const destinationRoot = path.join(repositoryRoot, "skills");

if (!existsSync(sourceRoot)) {
  console.error("[sync:skills] refusing to sync: assets/skills/ is missing.");
  process.exit(1);
}

const skillDirectories = readdirSync(sourceRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (skillDirectories.length === 0) {
  console.error("[sync:skills] refusing to sync: assets/skills/ is empty.");
  process.exit(1);
}

if (existsSync(destinationRoot)) rmSync(destinationRoot, { recursive: true, force: true });
mkdirSync(destinationRoot, { recursive: true });


for (const skillDirectory of skillDirectories) {
  const source = path.join(sourceRoot, skillDirectory);
  cpSync(source, path.join(destinationRoot, skillDirectory), { recursive: true });
}
