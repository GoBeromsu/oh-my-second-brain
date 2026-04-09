/**
 * OMSB Session Init
 *
 * SessionStart hook. Runs once per Claude Code session.
 * Checks if .omsb/rules.json exists and whether guideline sources are stale.
 */

import { readStdin } from './lib/stdin.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SAFE_OUTPUT = JSON.stringify({ continue: true, suppressOutput: true });

function findReadableUpTree(startDir, relativePath) {
  let current = path.resolve(startDir);

  while (true) {
    const candidate = path.join(current, relativePath);
    try {
      fs.accessSync(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      // continue upward
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function findRulesJson(startDir) {
  return findReadableUpTree(startDir, path.join('.omsb', 'rules.json'));
}

function findConfigJson(startDir) {
  return findReadableUpTree(startDir, 'omsb.config.json');
}

/**
 * Build advisory output for the hook.
 *
 * @param {string} message
 * @returns {string}
 */
function advisory(message) {
  return JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      additionalContext: `[OMSB] ${message}`,
    },
  });
}

/**
 * Check whether any source file tracked in the manifest is newer than its
 * recorded mtime.
 *
 * @param {{ source_mtimes: Record<string, number> }} manifest
 * @returns {boolean} true if any source is stale
 */
function hasStaleSource(manifest) {
  const mtimes = manifest.source_mtimes;
  if (!mtimes || typeof mtimes !== 'object') return false;

  for (const [filePath, recordedMtime] of Object.entries(mtimes)) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs > recordedMtime) {
        return true;
      }
    } catch {
      // File missing — treat as stale
      if (recordedMtime > 0) return true;
    }
  }

  return false;
}

function collectGuidelineMarkdownFiles(rootDir) {
  if (!rootDir) return [];
  try {
    fs.accessSync(rootDir, fs.constants.R_OK);
  } catch {
    return null;
  }

  const results = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(path.relative(rootDir, fullPath));
      }
    }
  }

  return results.sort();
}

function findLikelyGuidelineDirs(startDir) {
  const root = path.resolve(startDir);
  const results = [];
  const stack = [{ dir: root, depth: 0 }];

  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    if (depth > 3) continue;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (/guideline/i.test(entry.name)) {
        results.push(path.relative(root, fullPath) || '.');
      }
      stack.push({ dir: fullPath, depth: depth + 1 });
    }
  }

  return [...new Set(results)].sort();
}

function hasGuidelineSnapshotDrift(manifest) {
  const snapshot = manifest?.source_snapshot;
  if (!snapshot || typeof snapshot !== 'object') return false;

  const rootDir = snapshot.guidelines_root;
  if (typeof rootDir !== 'string' || rootDir.length === 0) return false;

  const currentFiles = collectGuidelineMarkdownFiles(rootDir);
  if (currentFiles === null) return true;

  const recorded = Array.isArray(snapshot.discovered_guideline_files)
    ? [...snapshot.discovered_guideline_files].sort()
    : [];

  if (recorded.length !== currentFiles.length) return true;
  return recorded.some((file, index) => file !== currentFiles[index]);
}

function buildRecoveryMessage(manifest, cwd) {
  const rootDir = manifest?.source_snapshot?.guidelines_root;
  const missingRoot =
    typeof rootDir === 'string' &&
    rootDir.length > 0 &&
    collectGuidelineMarkdownFiles(rootDir) === null;

  const candidates = findLikelyGuidelineDirs(cwd);
  const candidateText =
    candidates.length > 0
      ? ` Likely guideline folders: ${candidates.join(', ')}.`
      : '';

  if (missingRoot) {
    return `Configured guideline folder is missing or unreadable.${candidateText} Run /omsb init to confirm or recreate it.`;
  }

  return `OMSB rules may be outdated. Guideline files changed since last init.${candidateText} Run /omsb init to refresh.`;
}

async function main() {
  try {
    const raw = await readStdin(500);
    void raw;

    const rulesPath = findRulesJson(process.cwd());
    const configPath = findConfigJson(process.cwd());

    if (!rulesPath || !configPath) {
      process.stdout.write(
        advisory('OMSB not initialized. Run /omsb init to set up enforcement.')
      );
      return;
    }

    let manifest;
    try {
      const content = fs.readFileSync(rulesPath, 'utf-8');
      manifest = JSON.parse(content);
    } catch {
      // Corrupt manifest — treat as not initialized
      process.stdout.write(
        advisory('OMSB not initialized. Run /omsb init to set up enforcement.')
      );
      return;
    }

    if (hasStaleSource(manifest) || hasGuidelineSnapshotDrift(manifest)) {
      process.stdout.write(
        advisory(buildRecoveryMessage(manifest, process.cwd()))
      );
      return;
    }

    // All current — silent output
    process.stdout.write(SAFE_OUTPUT);
  } catch {
    // Always return safe output on any crash — never block the session
    process.stdout.write(SAFE_OUTPUT);
  }
}

main();
