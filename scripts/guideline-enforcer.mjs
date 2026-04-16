/**
 * OMSB Guideline Enforcer
 *
 * PreToolUse hook for Write|Edit|Bash.
 * Reads stdin (Claude Code tool context), enforces vault guidelines on AI behavior.
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

// ─── Glob matching ────────────────────────────────────────────────────────────

/**
 * Convert a glob pattern to a RegExp.
 * Supports ** (match anything including /) and * (match anything except /).
 */
const _globCache = new Map();
function globToRegex(pattern) {
  if (_globCache.has(pattern)) return _globCache.get(pattern);
  // Normalize separators and collapse consecutive ** sequences
  const p = pattern.replace(/\\/g, '/').replace(/(\*\*\/){2,}/g, '**/');
  let result;
  let regStr = '';
  let i = 0;
  while (i < p.length) {
    if (p[i] === '*' && p[i + 1] === '*') {
      // ** matches zero or more path segments including /
      // Consume optional trailing slash
      if (p[i + 2] === '/') {
        regStr += '(?:.+/)?';
        i += 3;
      } else {
        regStr += '.*';
        i += 2;
      }
    } else if (p[i] === '*') {
      // * matches anything except /
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
  result = new RegExp('^' + regStr + '$');
  _globCache.set(pattern, result);
  return result;
}

/**
 * Test whether a file path matches a glob pattern.
 * Tries both the full absolute path and relative suffixes.
 */
function matchesGlob(filePath, pattern) {
  const normalFile = filePath.replace(/\\/g, '/');
  const regex = globToRegex(pattern);
  if (regex.test(normalFile)) return true;

  // Also try matching against trailing path segments
  // e.g. pattern "80. References/**" against "/vault/80. References/foo.md"
  const parts = normalFile.split('/');
  for (let i = 0; i < parts.length; i++) {
    const sub = parts.slice(i).join('/');
    if (regex.test(sub)) return true;
  }
  return false;
}

// ─── YAML frontmatter parser ──────────────────────────────────────────────────

/**
 * Extract YAML frontmatter from markdown content.
 * Returns a Record<string, string> of key/value pairs (values as raw strings).
 * Returns null if no frontmatter found.
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
      // Strip surrounding quotes if present
      fields[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  return fields;
}

// ─── Vault root discovery ─────────────────────────────────────────────────────

/**
 * Walk up directory tree from startDir looking for .omsb/rules.json or omsb.config.json.
 * Returns the vault root path, or null if not found.
 */
function findVaultRoot(startDir) {
  let dir = startDir;
  const root = path.parse(dir).root;

  for (let i = 0; i < 20; i++) {
    // Check for .omsb/rules.json
    const rulesPath = path.join(dir, OMSB_DIR, RULES_FILE);
    if (fs.existsSync(rulesPath)) return dir;

    // Check for omsb.config.json
    const configPath = path.join(dir, CONFIG_FILE);
    if (fs.existsSync(configPath)) return dir;

    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
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

function hasStaleSource(manifest) {
  const mtimes = manifest?.source_mtimes;
  if (!mtimes || typeof mtimes !== 'object') return false;

  for (const [filePath, recordedMtime] of Object.entries(mtimes)) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs > recordedMtime) return true;
    } catch {
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

function buildRecoveryOutput(message) {
  return JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `[OMSB] ${message}`,
    },
  });
}

// ─── Bash path extraction ─────────────────────────────────────────────────────

/**
 * Try to extract a markdown file path from a simple Bash command.
 * Handles patterns like:
 *   echo "..." > file.md
 *   cat > file.md << EOF
 *   cat >> file.md
 * Returns null if pattern cannot be parsed.
 */
function extractPathFromBash(command) {
  if (!command) return null;

  // Redirection patterns: > file or >> file
  const redirectMatch = command.match(/>{1,2}\s*([^\s|&;]+\.(?:md|markdown))/);
  if (redirectMatch) return redirectMatch[1];

  // mv/cp: mv src dest (take dest)
  const mvMatch = command.match(/\bmv\s+\S+\s+(\S+\.(?:md|markdown))\b/);
  if (mvMatch) return mvMatch[1];

  return null;
}

// ─── Exception checking ───────────────────────────────────────────────────────

/**
 * Check if a modification is covered by path-boundary-exception rules.
 *
 * For a write to a raw-path file to be allowed, either:
 * 1. It only modifies allowed frontmatter fields (detected heuristically)
 * 2. It's an allowed op type
 *
 * For simplicity in the hook: we check if the ONLY changes are to allowed frontmatter.
 * We cannot easily detect wikilink-insert ops from content alone, so we pass on allowed_ops.
 */
function isExemptModification(exceptionRules, content, newString, toolName) {
  for (const excRule of exceptionRules) {
    const cfg = excRule.config;

    // Tier 1 exception: allowed_fields + allowed_ops
    const allowedFields = Array.isArray(cfg.allowed_fields) ? cfg.allowed_fields : [];
    const allowedOps = Array.isArray(cfg.allowed_ops) ? cfg.allowed_ops : [];

    // Tier 2 exception: allows = ["field:status", "op:wikilink-insert"]
    const allows = Array.isArray(cfg.allows) ? cfg.allows : [];
    for (const a of allows) {
      if (a.startsWith('field:')) allowedFields.push(a.slice(6));
      if (a.startsWith('op:')) allowedOps.push(a.slice(3));
    }

    // allowed_ops: only exempt if the tool is Bash (where we can't verify op type).
    // For Write/Edit, we can't confirm the op matches, so don't auto-exempt.
    if (allowedOps.length > 0 && toolName === 'Bash') return true;

    // If we have allowed_fields and the edit only touches frontmatter of those fields
    if (allowedFields.length > 0) {
      // For Edit operations, check if old/new string is scoped to allowed fields
      const editStr = newString || content || '';
      const isFrontmatterOnly = editStr.split('\n').every((line) => {
        if (!line.trim() || line === '---') return true;
        const colonIdx = line.indexOf(':');
        if (colonIdx !== -1) {
          const key = line.slice(0, colonIdx).trim();
          return allowedFields.includes(key);
        }
        return false;
      });
      if (isFrontmatterOnly) return true;
    }
  }

  return false;
}

// ─── Rule checkers ────────────────────────────────────────────────────────────

/**
 * Check path-boundary rules against a file path.
 * Returns the first matching rule or null.
 */
function checkPathBoundary(rules, filePath) {
  const boundaryRules = rules.filter((r) => r.type === 'path-boundary');
  for (const rule of boundaryRules) {
    const cfg = rule.config;

    // Tier 1: config.path (single string)
    if (typeof cfg.path === 'string') {
      if (matchesGlob(filePath, cfg.path)) return rule;
    }

    // Tier 2: config.paths (array of strings)
    if (Array.isArray(cfg.paths)) {
      for (const p of cfg.paths) {
        if (matchesGlob(filePath, p)) return rule;
      }
    }
  }
  return null;
}

/**
 * Check frontmatter-required rules.
 * Returns the first violated rule or null.
 */
function checkFrontmatterRequired(rules, content) {
  if (!content) return null;
  const fm = parseFrontmatter(content);
  if (!fm) {
    // No frontmatter at all — check if any required fields exist
    const requiredRules = rules.filter((r) => r.type === 'frontmatter-required');
    return requiredRules.length > 0 ? requiredRules[0] : null;
  }

  const requiredRules = rules.filter((r) => r.type === 'frontmatter-required');
  for (const rule of requiredRules) {
    const cfg = rule.config;
    // Tier 1: config.field (singular)
    const fieldName = typeof cfg.field === 'string' ? cfg.field : null;
    // Tier 2: config.fields (array) — not currently generated but defensive
    const fields = Array.isArray(cfg.fields) ? cfg.fields : fieldName ? [fieldName] : [];

    for (const f of fields) {
      if (!(f in fm)) return rule;
    }
  }
  return null;
}

/**
 * Check frontmatter-value rules.
 * Returns the first violated rule or null.
 */
function checkFrontmatterValue(rules, content) {
  if (!content) return null;
  const fm = parseFrontmatter(content);
  if (!fm) return null;

  const valueRules = rules.filter((r) => r.type === 'frontmatter-value');
  for (const rule of valueRules) {
    const cfg = rule.config;
    const fieldName = typeof cfg.field === 'string' ? cfg.field : null;
    if (!fieldName || !(fieldName in fm)) continue;

    const val = fm[fieldName];

    // enum check
    if (Array.isArray(cfg.enum) && !cfg.enum.includes(val)) return rule;

    // case check
    if (cfg.case === 'lowercase' && val !== val.toLowerCase()) return rule;

    // format check (date: YYYY-MM-DD)
    if (cfg.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(val)) return rule;

    // no_spaces check
    if (cfg.no_spaces && /\s/.test(val)) return rule;
  }
  return null;
}

/**
 * Check naming-convention rules against a file basename.
 * Returns the first violated rule or null.
 */
function checkNamingConvention(rules, filePath) {
  const basename = path.basename(filePath, path.extname(filePath));
  const namingRules = rules.filter((r) => r.type === 'naming-convention');

  for (const rule of namingRules) {
    const cfg = rule.config;

    // Check path_pattern first (if specified)
    if (typeof cfg.path_pattern === 'string') {
      if (!matchesGlob(filePath, cfg.path_pattern)) continue;
    }

    // Tier 1: config.pattern (regex string)
    const patternStr = typeof cfg.pattern === 'string' ? cfg.pattern : null;
    if (!patternStr) continue;

    try {
      // Guard against ReDoS: reject patterns with known catastrophic structures
      if (/(\.\*){2,}|\(\[?\^?[^\]]*\]\+\)\+|\(\.\+\)\+/.test(patternStr)) continue;
      if (patternStr.length > 200) continue; // reject excessively long patterns
      const regex = new RegExp(patternStr);
      if (!regex.test(basename)) return rule;
    } catch {
      // Invalid regex — skip
    }
  }

  return null;
}

// ─── Output builders ──────────────────────────────────────────────────────────

function buildBlockOutput(rule, filePath) {
  const exceptionRules = []; // We'll pass these in when calling
  const reason = [
    `[OMSB-BLOCK] Raw source modification blocked.`,
    ``,
    `Rule: ${rule.id} (Tier ${rule.source.tier})`,
    `Source: ${rule.source.file}`,
    `Path: ${filePath} is read-only.`,
    ``,
    `Use /omsb compile to process raw sources.`,
  ].join('\n');

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
    systemMessage: 'This file is protected by OMSB raw boundary enforcement.',
  });
}

function buildDenyOutput(rule, description, details) {
  const lines = [
    `[OMSB-DENY] ${description}`,
    ``,
    `Rule: ${rule.id} (Tier ${rule.source.tier})`,
  ];
  if (details) lines.push(details);

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: lines.join('\n'),
    },
    systemMessage: description,
  });
}

function buildAdvisoryOutput(rule, message) {
  return JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `[OMSB] ${message}\n\nRule: ${rule.id}`,
    },
  });
}

// ─── Main enforcement logic ───────────────────────────────────────────────────

/**
 * Enforce rules for a given file path and optional content.
 * Returns a JSON string to write to stdout.
 */
function enforce(manifest, filePath, content, newString, toolName) {
  const rules = manifest.rules;

  // ── 1. Path boundary check ──────────────────────────────────────────────────
  const boundaryRule = checkPathBoundary(rules, filePath);
  if (boundaryRule) {
    // Check if any exception applies
    const exceptionRules = rules.filter((r) => r.type === 'path-boundary-exception');
    const isExempt = isExemptModification(exceptionRules, content, newString, toolName);

    if (!isExempt) {
      if (boundaryRule.severity === 'block') {
        return buildBlockOutput(boundaryRule, filePath);
      }
      if (boundaryRule.severity === 'deny') {
        return buildDenyOutput(
          boundaryRule,
          `Write to protected path: ${path.basename(filePath)}`,
          `Path: ${filePath} matches raw boundary pattern.`
        );
      }
      if (boundaryRule.severity === 'advisory') {
        return buildAdvisoryOutput(
          boundaryRule,
          `Writing to a raw source path: ${filePath}`
        );
      }
    }
  }

  // ── 2. Only check frontmatter/naming if we have content (Write, not just Edit path) ──
  // For Edit: we check the new_string for frontmatter violations
  const checkContent = content || newString;

  // Only check .md files for frontmatter/naming
  const isMd = /\.(?:md|markdown)$/i.test(filePath);

  if (isMd && checkContent) {
    // ── 3. Frontmatter required ─────────────────────────────────────────────
    const fmRequiredRule = checkFrontmatterRequired(rules, checkContent);
    if (fmRequiredRule) {
      const fieldName =
        typeof fmRequiredRule.config.field === 'string'
          ? fmRequiredRule.config.field
          : (Array.isArray(fmRequiredRule.config.fields)
              ? fmRequiredRule.config.fields.join(', ')
              : 'unknown');

      const desc = `Missing required frontmatter field: "${fieldName}"`;
      if (fmRequiredRule.severity === 'block') return buildBlockOutput(fmRequiredRule, filePath);
      if (fmRequiredRule.severity === 'deny') return buildDenyOutput(fmRequiredRule, desc, `File: ${filePath}`);
      if (fmRequiredRule.severity === 'advisory') return buildAdvisoryOutput(fmRequiredRule, desc);
    }

    // ── 4. Frontmatter value ────────────────────────────────────────────────
    const fmValueRule = checkFrontmatterValue(rules, checkContent);
    if (fmValueRule) {
      const field = fmValueRule.config.field || 'unknown';
      const fm = parseFrontmatter(checkContent) || {};
      const actual = fm[field] ?? '(missing)';
      const allowed = Array.isArray(fmValueRule.config.enum)
        ? fmValueRule.config.enum.join(', ')
        : fmValueRule.config.case || fmValueRule.config.format || '';

      const desc = `Invalid value for frontmatter field "${field}": "${actual}"`;
      const details = allowed ? `Allowed: ${allowed}` : '';
      if (fmValueRule.severity === 'block') return buildBlockOutput(fmValueRule, filePath);
      if (fmValueRule.severity === 'deny') return buildDenyOutput(fmValueRule, desc, details);
      if (fmValueRule.severity === 'advisory') return buildAdvisoryOutput(fmValueRule, desc);
    }
  }

  // ── 5. Naming convention ──────────────────────────────────────────────────
  if (isMd) {
    const namingRule = checkNamingConvention(rules, filePath);
    if (namingRule) {
      const basename = path.basename(filePath);
      const pattern = namingRule.config.pattern || '';
      const desc = `File name "${basename}" does not match naming convention`;
      const details = `Pattern: ${pattern}`;
      if (namingRule.severity === 'block') return buildBlockOutput(namingRule, filePath);
      if (namingRule.severity === 'deny') return buildDenyOutput(namingRule, desc, details);
      if (namingRule.severity === 'advisory') return buildAdvisoryOutput(namingRule, desc);
    }
  }

  return SAFE_OUTPUT;
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

    let filePath = null;
    let content = null;
    let newString = null;

    if (toolName === 'Write') {
      filePath = toolInput.file_path || null;
      content = toolInput.content || null;
    } else if (toolName === 'Edit' || toolName === 'MultiEdit') {
      filePath = toolInput.file_path || null;
      newString = toolInput.new_string || null;
    } else if (toolName === 'Bash') {
      const cmd = toolInput.command || '';
      const extracted = extractPathFromBash(cmd);
      if (!extracted) {
        // Can't parse bash — don't block
        process.stdout.write(SAFE_OUTPUT);
        return;
      }
      filePath = path.isAbsolute(extracted) ? extracted : path.resolve(process.cwd(), extracted);
      content = null;
    } else {
      // Unknown tool — pass through
      process.stdout.write(SAFE_OUTPUT);
      return;
    }

    if (!filePath) {
      process.stdout.write(SAFE_OUTPUT);
      return;
    }

    // Find vault root from the file's directory
    const fileDir = path.isAbsolute(filePath)
      ? path.dirname(filePath)
      : path.dirname(path.resolve(process.cwd(), filePath));

    const vaultRoot = findVaultRoot(fileDir);
    if (!vaultRoot) {
      // No OMSB config found — pass through silently
      process.stdout.write(SAFE_OUTPUT);
      return;
    }

    const manifest = loadRules(vaultRoot);
    if (!manifest) {
      // No rules compiled yet — pass through
      process.stdout.write(SAFE_OUTPUT);
      return;
    }

    const configPath = path.join(vaultRoot, CONFIG_FILE);
    if (
      !fs.existsSync(configPath) ||
      hasStaleSource(manifest) ||
      hasGuidelineSnapshotDrift(manifest)
    ) {
      process.stdout.write(
        buildRecoveryOutput(
          'OMSB enforcement is inactive until /omsb init refreshes the vault-local config and rules snapshot.'
        )
      );
      return;
    }

    const result = enforce(manifest, filePath, content, newString, toolName);
    process.stdout.write(result);
  } catch {
    // Always return safe output on any crash — never block the tool
    process.stdout.write(SAFE_OUTPUT);
  }
}

main();
