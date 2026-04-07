/**
 * OMSB Authorship Marker
 *
 * PostToolUse hook for Write|Edit.
 * Reads stdin (Claude Code tool result context), auto-marks AI authorship on vault files.
 *
 * SELF-CONTAINED: No imports from src/ or dist/. All logic is inlined.
 * Only external import: ./lib/stdin.mjs
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readStdin } from './lib/stdin.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

const SAFE_OUTPUT = JSON.stringify({ continue: true, suppressOutput: true });
const OMSB_DIR = '.omsb';
const RULES_FILE = 'rules.json';
const CONFIG_FILE = 'omsb.config.json';

// ─── Vault root discovery ─────────────────────────────────────────────────────

/**
 * Walk up directory tree from startDir looking for .omsb/rules.json or omsb.config.json.
 * Returns the vault root path, or null if not found.
 */
function findVaultRoot(startDir) {
  let dir = startDir;
  const root = path.parse(dir).root;

  for (let i = 0; i < 20; i++) {
    const rulesPath = path.join(dir, OMSB_DIR, RULES_FILE);
    if (fs.existsSync(rulesPath)) return dir;

    const configPath = path.join(dir, CONFIG_FILE);
    if (fs.existsSync(configPath)) return dir;

    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

// ─── Config loader ────────────────────────────────────────────────────────────

/**
 * Load omsb.config.json from vaultRoot.
 * Returns the parsed object or null if not found/invalid.
 */
function loadConfig(vaultRoot) {
  const configPath = path.join(vaultRoot, CONFIG_FILE);
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── Rules loader ─────────────────────────────────────────────────────────────

/**
 * Load RuleManifest from vaultRoot/.omsb/rules.json.
 * Returns null if not found or invalid.
 */
function loadRules(vaultRoot) {
  const rulesPath = path.join(vaultRoot, OMSB_DIR, RULES_FILE);
  try {
    const raw = fs.readFileSync(rulesPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || !Array.isArray(parsed.rules)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Glob matching ────────────────────────────────────────────────────────────

/**
 * Convert a glob pattern to a RegExp.
 */
const _globCache = new Map();
function globToRegex(pattern) {
  if (_globCache.has(pattern)) return _globCache.get(pattern);
  const p = pattern.replace(/\\/g, '/').replace(/(\*\*\/){2,}/g, '**/');
  let regStr = '';
  let i = 0;
  while (i < p.length) {
    if (p[i] === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') {
        regStr += '(?:.+/)?';
        i += 3;
      } else {
        regStr += '.*';
        i += 2;
      }
    } else if (p[i] === '*') {
      regStr += '[^/]*';
      i++;
    } else if (p[i] === '?') {
      regStr += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(p[i])) {
      regStr += '\\' + p[i];
      i++;
    } else {
      regStr += p[i];
      i++;
    }
  }
  const result = new RegExp('^' + regStr + '$');
  _globCache.set(pattern, result);
  return result;
}

/**
 * Test whether a file path matches a glob pattern.
 */
function matchesGlob(filePath, pattern) {
  const normalFile = filePath.replace(/\\/g, '/');
  const regex = globToRegex(pattern);
  if (regex.test(normalFile)) return true;

  const parts = normalFile.split('/');
  for (let i = 0; i < parts.length; i++) {
    const sub = parts.slice(i).join('/');
    if (regex.test(sub)) return true;
  }
  return false;
}

// ─── Raw path check ───────────────────────────────────────────────────────────

/**
 * Check if filePath is in any of the raw_paths patterns.
 * Raw source files should not have authorship markers added.
 */
function isRawPath(rawPaths, filePath) {
  for (const pattern of rawPaths) {
    if (matchesGlob(filePath, pattern)) return true;
  }
  return false;
}

// ─── Frontmatter manipulation ─────────────────────────────────────────────────

/**
 * Parse frontmatter from markdown content.
 * Returns { fields: Record<string,string>, bodyStart: number } or null if no frontmatter.
 * bodyStart is the index in content where the body (after closing ---) begins.
 */
function parseFrontmatter(content) {
  if (!content || !content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;

  const yaml = content.slice(3, end).trim();
  const fields = {};

  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (key) {
      fields[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  // bodyStart points past the closing `---\n`
  const bodyStart = end + 4; // '\n---' is 4 chars
  return { fields, bodyStart };
}

/**
 * Rebuild frontmatter block with updated fields injected/replaced.
 * Preserves all existing lines; adds or replaces specific fields.
 *
 * @param {string} content - Full file content
 * @param {Record<string, string>} updates - Fields to set (key → value)
 * @returns {string} Updated content
 */
function setFrontmatterFields(content, updates) {
  if (!content || !content.startsWith('---')) {
    // No frontmatter — prepend one
    const fm = Object.entries(updates)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    return `---\n${fm}\n---\n${content}`;
  }

  const end = content.indexOf('\n---', 3);
  if (end === -1) {
    // Malformed — prepend new block
    const fm = Object.entries(updates)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    return `---\n${fm}\n---\n${content}`;
  }

  const yamlBlock = content.slice(3, end);
  const body = content.slice(end + 4); // skip '\n---'

  // Process lines, replacing or marking existing keys
  const lines = yamlBlock.split('\n');
  const replaced = new Set();
  const newLines = lines.map((line) => {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return line;
    const key = line.slice(0, colonIdx).trim();
    if (key in updates) {
      replaced.add(key);
      return `${key}: ${updates[key]}`;
    }
    return line;
  });

  // Append any fields not yet present
  for (const [key, val] of Object.entries(updates)) {
    if (!replaced.has(key)) {
      newLines.push(`${key}: ${val}`);
    }
  }

  return `---${newLines.join('\n')}\n---${body}`;
}

// ─── Bash path extraction ─────────────────────────────────────────────────────

/**
 * Try to extract a markdown file path from a simple Bash command.
 */
function extractPathFromBash(command) {
  if (!command) return null;

  const redirectMatch = command.match(/>{1,2}\s*([^\s|&;]+\.(?:md|markdown))/);
  if (redirectMatch) return redirectMatch[1];

  const mvMatch = command.match(/\bmv\s+\S+\s+(\S+\.(?:md|markdown))\b/);
  if (mvMatch) return mvMatch[1];

  return null;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  try {
    const raw = await readStdin(3000);
    if (!raw || !raw.trim()) {
      process.stdout.write(SAFE_OUTPUT);
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      process.stdout.write(SAFE_OUTPUT);
      return;
    }

    const toolName = payload.tool_name || '';
    const toolInput = payload.tool_input || {};

    // Extract file path from tool input
    let filePath = null;

    if (toolName === 'Write') {
      filePath = toolInput.file_path || null;
    } else if (toolName === 'Edit' || toolName === 'MultiEdit') {
      filePath = toolInput.file_path || null;
    } else if (toolName === 'Bash') {
      const cmd = toolInput.command || '';
      const extracted = extractPathFromBash(cmd);
      if (!extracted) {
        process.stdout.write(SAFE_OUTPUT);
        return;
      }
      filePath = path.isAbsolute(extracted) ? extracted : path.resolve(process.cwd(), extracted);
    } else {
      process.stdout.write(SAFE_OUTPUT);
      return;
    }

    if (!filePath) {
      process.stdout.write(SAFE_OUTPUT);
      return;
    }

    // Only process .md files
    if (!/\.(?:md|markdown)$/i.test(filePath)) {
      process.stdout.write(SAFE_OUTPUT);
      return;
    }

    // Resolve to absolute path
    const absFilePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);

    // Find vault root from the file's directory
    const fileDir = path.dirname(absFilePath);
    const vaultRoot = findVaultRoot(fileDir);
    if (!vaultRoot) {
      process.stdout.write(SAFE_OUTPUT);
      return;
    }

    // Load config for authorship settings
    const config = loadConfig(vaultRoot);
    if (!config) {
      process.stdout.write(SAFE_OUTPUT);
      return;
    }

    // Check authorship is enabled
    const authorship = config.authorship;
    if (!authorship || !authorship.enabled) {
      process.stdout.write(SAFE_OUTPUT);
      return;
    }

    const agentName = authorship.agent_name || 'claude';
    const createdByField = authorship.created_by_field || 'created_by';
    const modifiedByField = authorship.modified_by_field || 'modified_by';
    const agentWikilink = `"[[${agentName}]]"`;

    // Check if file is in raw_paths — skip if so
    const manifest = loadRules(vaultRoot);
    if (manifest) {
      const rawPaths = manifest.rules
        .filter((r) => r.type === 'path-boundary')
        .flatMap((r) => {
          const cfg = r.config;
          const paths = [];
          if (typeof cfg.path === 'string') paths.push(cfg.path);
          if (Array.isArray(cfg.paths)) paths.push(...cfg.paths);
          return paths;
        });

      if (isRawPath(rawPaths, absFilePath)) {
        process.stdout.write(SAFE_OUTPUT);
        return;
      }
    } else {
      // Also check raw_paths directly from config.rules if manifest not available
      const rawPaths = Array.isArray(config.rules?.raw_paths) ? config.rules.raw_paths : [];
      if (isRawPath(rawPaths, absFilePath)) {
        process.stdout.write(SAFE_OUTPUT);
        return;
      }
    }

    // Read the file that was just written/edited
    let fileContent;
    try {
      fileContent = fs.readFileSync(absFilePath, 'utf-8');
    } catch {
      // File doesn't exist or can't be read — skip silently
      process.stdout.write(SAFE_OUTPUT);
      return;
    }

    // Parse frontmatter to determine new vs existing file
    const fm = parseFrontmatter(fileContent);
    const existingFields = fm ? fm.fields : {};

    let updates;
    if (createdByField in existingFields) {
      // File already has created_by — update modified_by
      updates = { [modifiedByField]: agentWikilink };
    } else {
      // New file — set created_by
      updates = { [createdByField]: agentWikilink };
    }

    const updatedContent = setFrontmatterFields(fileContent, updates);

    // Only write if content actually changed
    if (updatedContent !== fileContent) {
      fs.writeFileSync(absFilePath, updatedContent, 'utf-8');
    }

    process.stdout.write(SAFE_OUTPUT);
  } catch {
    // Always return safe output on any crash — never block the tool
    process.stdout.write(SAFE_OUTPUT);
  }
}

main();
