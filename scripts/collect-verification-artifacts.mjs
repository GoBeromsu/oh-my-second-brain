#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

function usage() {
  console.error('Usage: node scripts/collect-verification-artifacts.mjs <vault-path> <out-dir>');
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function collectPluginDataFiles(vaultPath) {
  const pluginsDir = join(vaultPath, '.obsidian', 'plugins');
  if (!existsSync(pluginsDir)) return [];

  const results = [];
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dataPath = join(pluginsDir, entry.name, 'data.json');
    if (isFile(dataPath)) results.push(dataPath);
  }
  return results.sort();
}

const vaultArg = process.argv[2];
const outArg = process.argv[3];
if (!vaultArg || !outArg) {
  usage();
  process.exit(1);
}

const vaultPath = resolve(vaultArg);
const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });

const candidateFiles = [
  join(vaultPath, 'omsb.config.json'),
  join(vaultPath, '.omsb', 'rules.json'),
  join(vaultPath, '.omsb', 'CLAUDE.md'),
  join(vaultPath, '.claude', 'CLAUDE.md'),
  ...collectPluginDataFiles(vaultPath),
];

const copied = [];
for (const source of candidateFiles) {
  if (!isFile(source)) continue;
  const rel = relative(vaultPath, source);
  const dest = join(outDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(source, dest);
  copied.push(rel);
}
copied.sort();

const manifest = {
  vaultPath,
  outDir,
  copied,
  generatedAt: new Date().toISOString(),
  note: 'Artifacts collected for sanitized manual verification. Review contents before sharing externally.',
};

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
console.log(`[OMSB] Collected ${copied.length} artifact(s) into ${outDir}`);
for (const rel of copied) {
  console.log(`- ${rel}`);
}
