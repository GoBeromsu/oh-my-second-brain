import * as fs from "node:fs";
import * as path from "node:path";

export interface TermCacheEntry {
  name: string;
  aliases: string[];
  path: string;
}

/**
 * Parse YAML frontmatter from markdown content.
 * Returns a record of key→value strings (simple scalar values only).
 */
function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (match === null) return {};

  const result: Record<string, unknown> = {};
  const body = match[1];

  // Parse title and aliases (the only fields we need)
  for (const line of body.split("\n")) {
    const titleMatch = line.match(/^title\s*:\s*(.+)$/);
    if (titleMatch) {
      result["title"] = titleMatch[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }

    // aliases: [a, b] or aliases: - a\n - b
    const aliasesInlineMatch = line.match(/^aliases\s*:\s*\[(.+)\]$/);
    if (aliasesInlineMatch) {
      result["aliases"] = aliasesInlineMatch[1]
        .split(",")
        .map((a) => a.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
  }

  // Handle block-style aliases list
  if (!("aliases" in result)) {
    const aliasesBlockMatch = body.match(/^aliases\s*:\s*\n((?:\s*-\s*.+\n?)*)/m);
    if (aliasesBlockMatch) {
      result["aliases"] = aliasesBlockMatch[1]
        .split("\n")
        .map((line) => line.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
  }

  return result;
}

/**
 * Recursively collect .md file paths under a directory.
 */
function collectMdFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMdFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Build a term cache from a terminology directory.
 * Scans for .md files, extracts title and aliases from frontmatter.
 * Returns entries sorted by name length (longest first) for greedy matching.
 */
export function buildTermCache(terminologyDir: string): TermCacheEntry[] {
  const files = collectMdFiles(terminologyDir);
  const entries: TermCacheEntry[] = [];

  for (const filePath of files) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const fm = parseFrontmatter(content);
    const basename = path.basename(filePath, ".md");
    const name = typeof fm["title"] === "string" ? fm["title"] : basename;
    const aliases = Array.isArray(fm["aliases"])
      ? (fm["aliases"] as unknown[])
          .filter((a): a is string => typeof a === "string")
      : [];

    entries.push({ name, aliases, path: filePath });
  }

  // Sort longest name first for greedy wikilink matching
  entries.sort((a, b) => b.name.length - a.name.length);

  return entries;
}

/**
 * Write term cache to a file (for use by compile agents).
 * Format: name\taliases_csv\tpath  (one entry per line)
 */
export function writeTermCache(entries: TermCacheEntry[], outputPath: string): void {
  const lines = entries.map(
    (e) => `${e.name}\t${e.aliases.join(",")}\t${e.path}`,
  );
  fs.writeFileSync(outputPath, lines.join("\n") + "\n", "utf-8");
}
