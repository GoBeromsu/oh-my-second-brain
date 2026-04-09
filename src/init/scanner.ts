import * as fs from "node:fs";
import * as path from "node:path";

export interface VaultScanResult {
  vaultPath: string;
  guidelineDir: string | null;
  guidelineFiles: string[];
  rawCandidates: string[];
  managedPluginCandidates: string[];
  frontmatterPatterns: string[];
  noteCount: number;
}

/**
 * Recursively collect all .md files under a directory.
 * Returns relative paths from the given root.
 */
function collectMdFiles(dir: string, root: string, results: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    // Skip hidden directories
    if (entry.name.startsWith(".")) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMdFiles(fullPath, root, results);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(path.relative(root, fullPath));
    }
  }
}

/**
 * Parse YAML frontmatter from a markdown file content.
 * Returns field names found between the opening and closing --- delimiters.
 */
function parseFrontmatterFields(content: string): string[] {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return [];

  const body = match[1];
  const fields: string[] = [];

  for (const line of body.split("\n")) {
    const fieldMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):/);
    if (fieldMatch) {
      fields.push(fieldMatch[1]);
    }
  }

  return fields;
}

/**
 * Find directories matching guideline-like patterns under the vault root.
 * Returns the directory path relative to the vault, or null if not found.
 */
function findGuidelineDir(vaultPath: string): string | null {
  // Patterns to search for guideline directories
  const patterns = [
    /guideline/i,
    /Guideline/,
  ];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(vaultPath, { withFileTypes: true });
  } catch {
    return null;
  }

  // Search depth-first, up to 3 levels deep
  function search(dir: string, depth: number): string | null {
    if (depth > 3) return null;

    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of dirEntries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;

      const matches = patterns.some((p) => p.test(entry.name));
      if (matches) {
        return path.relative(vaultPath, path.join(dir, entry.name));
      }
    }

    // Recurse into subdirectories
    for (const entry of dirEntries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;

      const found = search(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }

    return null;
  }

  return search(vaultPath, 0);
}

function listMdFilesInDir(dirPath: string, root = dirPath): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listMdFilesInDir(fullPath, root));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(path.relative(root, fullPath));
    }
  }

  return results.sort();
}

/**
 * Find raw source candidate directories (References, Sources, etc.)
 * Returns relative paths from vault root.
 */
function findRawCandidates(vaultPath: string): string[] {
  const patterns = [
    /^reference/i,
    /^source/i,
    /^resource/i,
    /^clipping/i,
    /^archive/i,
  ];

  const candidates: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(vaultPath, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;

    if (patterns.some((p) => p.test(entry.name))) {
      candidates.push(entry.name);
    }
  }

  // Also check one level deep
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;

    let subEntries: fs.Dirent[];
    try {
      subEntries = fs.readdirSync(path.join(vaultPath, entry.name), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sub of subEntries) {
      if (!sub.isDirectory()) continue;
      if (sub.name.startsWith(".")) continue;

      if (patterns.some((p) => p.test(sub.name))) {
        candidates.push(path.join(entry.name, sub.name));
      }
    }
  }

  return candidates;
}

function findManagedPluginCandidates(vaultPath: string): string[] {
  const pluginsDir = path.join(vaultPath, ".obsidian", "plugins");
  if (!fs.existsSync(pluginsDir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) =>
      fs.existsSync(path.join(pluginsDir, entry.name, "data.json"))
    )
    .map((entry) => entry.name)
    .sort();
}

/**
 * Sample up to N random elements from an array.
 */
function sampleN<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;

  const sampled: T[] = [];
  const indices = new Set<number>();

  while (indices.size < n) {
    indices.add(Math.floor(Math.random() * arr.length));
  }

  for (const i of indices) {
    sampled.push(arr[i]);
  }

  return sampled;
}

/**
 * Scan a vault directory to discover its structure.
 */
export async function scanVault(vaultPath: string): Promise<VaultScanResult> {
  const absVaultPath = path.resolve(vaultPath);

  // Collect all .md files
  const allMdFiles: string[] = [];
  collectMdFiles(absVaultPath, absVaultPath, allMdFiles);

  const noteCount = allMdFiles.length;

  // Find guideline directory
  const guidelineDir = findGuidelineDir(absVaultPath);

  // Get guideline files if directory found
  let guidelineFiles: string[] = [];
  if (guidelineDir) {
    const absGuidelineDir = path.join(absVaultPath, guidelineDir);
    guidelineFiles = listMdFilesInDir(absGuidelineDir);
  }

  // Find raw candidates
  const rawCandidates = findRawCandidates(absVaultPath);
  const managedPluginCandidates = findManagedPluginCandidates(absVaultPath);

  // Sample frontmatter patterns from up to 20 random notes
  const sample = sampleN(allMdFiles, 20);
  const fieldCounts: Record<string, number> = {};

  for (const relFile of sample) {
    const filePath = path.join(absVaultPath, relFile);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const fields = parseFrontmatterFields(content);
    for (const field of fields) {
      fieldCounts[field] = (fieldCounts[field] ?? 0) + 1;
    }
  }

  // Return fields that appear in at least 2 sampled files, sorted by frequency
  const frontmatterPatterns = Object.entries(fieldCounts)
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a)
    .map(([field]) => field);

  return {
    vaultPath: absVaultPath,
    guidelineDir,
    guidelineFiles,
    rawCandidates,
    managedPluginCandidates,
    frontmatterPatterns,
    noteCount,
  };
}
