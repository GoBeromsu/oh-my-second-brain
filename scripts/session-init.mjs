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
      hookEventName: 'SessionStart',
      additionalContext: `[OMSB] ${message}`,
    },
  });
}

function collectStaleSourceDetails(manifest) {
  const mtimes = manifest.source_mtimes;
  const details = {
    modified: [],
    missing: [],
  };

  if (!mtimes || typeof mtimes !== 'object') return details;

  for (const [filePath, recordedMtime] of Object.entries(mtimes)) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs > recordedMtime) {
        details.modified.push(filePath);
      }
    } catch {
      // File missing — treat as stale
      if (recordedMtime > 0) details.missing.push(filePath);
    }
  }

  return details;
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

function collectGuidelineSnapshotDrift(manifest) {
  const snapshot = manifest?.source_snapshot;
  if (!snapshot || typeof snapshot !== 'object') {
    return {
      missingRoot: false,
      added: [],
      removed: [],
    };
  }

  const rootDir = snapshot.guidelines_root;
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    return {
      missingRoot: false,
      added: [],
      removed: [],
    };
  }

  const currentFiles = collectGuidelineMarkdownFiles(rootDir);
  if (currentFiles === null) {
    return {
      missingRoot: true,
      added: [],
      removed: [],
    };
  }

  const recorded = Array.isArray(snapshot.discovered_guideline_files)
    ? [...snapshot.discovered_guideline_files].sort()
    : [];

  const recordedSet = new Set(recorded);
  const currentSet = new Set(currentFiles);

  return {
    missingRoot: false,
    added: currentFiles.filter((file) => !recordedSet.has(file)),
    removed: recorded.filter((file) => !currentSet.has(file)),
  };
}

function hasStaleSource(details) {
  return details.modified.length > 0 || details.missing.length > 0;
}

function hasGuidelineSnapshotDrift(details) {
  return details.missingRoot || details.added.length > 0 || details.removed.length > 0;
}

function summarizePaths(filePaths, cwd, maxItems = 3) {
  const pretty = filePaths
    .map((filePath) => path.relative(cwd, filePath) || filePath)
    .slice(0, maxItems);
  const suffix = filePaths.length > maxItems ? ` (+${filePaths.length - maxItems} more)` : '';
  return pretty.join(', ') + suffix;
}

function buildRecoveryMessage(manifest, cwd, staleDetails, snapshotDrift) {
  const candidates = findLikelyGuidelineDirs(cwd);
  const candidateText =
    candidates.length > 0
      ? ` Likely guideline folders: ${candidates.join(', ')}.`
      : '';

  if (snapshotDrift.missingRoot) {
    return `Configured guideline folder is missing or unreadable.${candidateText} Run /omsb init to confirm or recreate it.`;
  }

  const reasons = [];
  if (staleDetails.modified.length > 0) {
    reasons.push(
      `modified tracked sources: ${summarizePaths(staleDetails.modified, cwd)}`,
    );
  }
  if (staleDetails.missing.length > 0) {
    reasons.push(
      `missing tracked sources: ${summarizePaths(staleDetails.missing, cwd)}`,
    );
  }
  if (snapshotDrift.added.length > 0) {
    reasons.push(`added guideline files: ${snapshotDrift.added.slice(0, 3).join(', ')}`);
  }
  if (snapshotDrift.removed.length > 0) {
    reasons.push(`removed or renamed guideline files: ${snapshotDrift.removed.slice(0, 3).join(', ')}`);
  }

  const reasonText = reasons.length > 0
    ? ` Detected ${reasons.join('; ')}.`
    : ' Guideline files changed since last init.';

  return `OMSB rules may be outdated.${reasonText}${candidateText} Run /omsb init to refresh.`;
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

    const staleDetails = collectStaleSourceDetails(manifest);
    const snapshotDrift = collectGuidelineSnapshotDrift(manifest);

    if (hasStaleSource(staleDetails) || hasGuidelineSnapshotDrift(snapshotDrift)) {
      process.stdout.write(
        advisory(buildRecoveryMessage(manifest, process.cwd(), staleDetails, snapshotDrift))
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
