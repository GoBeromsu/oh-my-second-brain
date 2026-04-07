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

/**
 * Walk up from startDir looking for .omsb/rules.json.
 * Returns the absolute path to rules.json, or null if not found.
 *
 * @param {string} startDir
 * @returns {string | null}
 */
function findRulesJson(startDir) {
  let current = path.resolve(startDir);

  while (true) {
    const candidate = path.join(current, '.omsb', 'rules.json');
    try {
      fs.accessSync(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      // not found at this level
    }

    const parent = path.dirname(current);
    if (parent === current) {
      // reached filesystem root
      return null;
    }
    current = parent;
  }
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

async function main() {
  try {
    const raw = await readStdin(500);
    void raw;

    const rulesPath = findRulesJson(process.cwd());

    if (!rulesPath) {
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

    if (hasStaleSource(manifest)) {
      process.stdout.write(
        advisory(
          'OMSB rules may be outdated. Guideline files changed since last init. Run /omsb init to refresh.'
        )
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
