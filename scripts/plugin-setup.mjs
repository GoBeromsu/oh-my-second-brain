#!/usr/bin/env node
/**
 * OMSB Plugin Post-Install Setup
 *
 * Patches hooks.json to use the absolute node binary path,
 * ensuring hooks work under nvm/fnm where bare `node` may not resolve.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const nodeBin = process.execPath;

console.log('[OMSB] Running post-install setup...');

try {
  const hooksPath = join(__dirname, '..', 'hooks', 'hooks.json');
  const data = JSON.parse(readFileSync(hooksPath, 'utf-8'));
  let patched = false;

  for (const groups of Object.values(data.hooks ?? {})) {
    for (const group of groups) {
      for (const hook of (group.hooks ?? [])) {
        if (typeof hook.command !== 'string') continue;
        if (!hook.command.includes('/scripts/run.cjs')) continue;
        // Match bare `node ` (first install) or quoted absolute path (re-install/nvm switch)
        if (hook.command.startsWith('node ')) {
          hook.command = hook.command.replace(/^node\b/, `"${nodeBin}"`);
          patched = true;
        } else if (/^"[^"]+"/.test(hook.command)) {
          hook.command = hook.command.replace(/^"[^"]+"/, `"${nodeBin}"`);
          patched = true;
        }
      }
    }
  }

  if (patched) {
    writeFileSync(hooksPath, JSON.stringify(data, null, 2) + '\n');
    console.log(`[OMSB] Patched hooks.json with absolute node path (${nodeBin})`);
  } else {
    console.log('[OMSB] hooks.json already up to date');
  }
} catch (e) {
  console.warn('[OMSB] Warning: Could not patch hooks.json:', e.message);
}

console.log('[OMSB] Setup complete.');
