import * as fs from "node:fs";
import * as path from "node:path";
import type { OmsbConfig } from "../rules/types.js";
import { buildTermCache } from "./term-cache.js";
import { VideoAdapter } from "./adapters/video.js";
import { addAuthorship, DEFAULT_AUTHORSHIP } from "../authorship/marker.js";

export interface CompileOptions {
  dryRun?: boolean;
  filter?: { status?: string; type?: string };
  batchSize?: number;
}

export interface CompileResult {
  processed: number;
  skipped: number;
  errors: string[];
  outputs: string[];
}

/**
 * Parse frontmatter from a markdown file.
 * Returns a record of key→string values.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (match === null) return result;

  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Update a frontmatter field in markdown content.
 * If the field exists, replaces its value. Otherwise appends it before closing ---.
 */
function setFrontmatterField(content: string, field: string, value: string): string {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch === null) {
    return `---\n${field}: ${value}\n---\n${content}`;
  }

  const fmBody = fmMatch[1];
  const fmFull = fmMatch[0];
  const fieldRegex = new RegExp(`^${field}\\s*:.*$`, "m");

  if (fieldRegex.test(fmBody)) {
    const newFmBody = fmBody.replace(fieldRegex, `${field}: ${value}`);
    return content.replace(fmFull, fmFull.replace(fmBody, newFmBody));
  }

  // Append field before closing ---
  const newFmFull = fmFull.replace(/(\r?\n)---$/, `\n${field}: ${value}$1---`);
  return content.replace(fmFull, newFmFull);
}

/**
 * Recursively collect .md file paths from a directory.
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
 * Find source files matching compile config.
 * Scans config.compile.sources paths for .md files.
 * Filters by frontmatter status if options.filter.status is specified.
 */
export function findSources(config: OmsbConfig, options?: CompileOptions): string[] {
  if (config.compile === undefined) {
    throw new Error(
      "omsb compile: config.compile is not defined. Add a compile block to omsb.config.json.",
    );
  }

  const statusFilter = options?.filter?.status ?? "todo";
  const typeFilter = options?.filter?.type;
  const sources: string[] = [];

  for (const sourcePath of config.compile.sources) {
    const resolved = path.isAbsolute(sourcePath)
      ? sourcePath
      : path.join(config.vault_path, sourcePath);

    const files = collectMdFiles(resolved);

    for (const filePath of files) {
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      const fm = parseFrontmatter(content);

      if (statusFilter && fm["status"] !== statusFilter) continue;
      if (typeFilter && fm["type"] !== typeFilter) continue;

      sources.push(filePath);
    }
  }

  return sources;
}

/**
 * Run the compile pipeline.
 * 1. Build term cache from terminology directory
 * 2. Find sources (status: todo by default)
 * 3. Process each source through the appropriate adapter
 * 4. Write output files with authorship marking
 * 5. Return results
 */
export async function compileVault(
  config: OmsbConfig,
  vaultPath: string,
  options?: CompileOptions,
): Promise<CompileResult> {
  if (config.compile === undefined) {
    throw new Error(
      "omsb compile: config.compile is not defined. Add a compile block to omsb.config.json.",
    );
  }

  const result: CompileResult = {
    processed: 0,
    skipped: 0,
    errors: [],
    outputs: [],
  };

  // Step 1: Build term cache
  const terminologyDir = config.compile.terminology_dir
    ? path.isAbsolute(config.compile.terminology_dir)
      ? config.compile.terminology_dir
      : path.join(vaultPath, config.compile.terminology_dir)
    : null;

  const termCache = terminologyDir !== null ? buildTermCache(terminologyDir) : [];

  // Step 2: Find sources
  const sources = findSources(config, options);

  const wikiOutputDir = config.compile.outputs.wiki
    ? path.isAbsolute(config.compile.outputs.wiki)
      ? config.compile.outputs.wiki
      : path.join(vaultPath, config.compile.outputs.wiki)
    : "";

  const videoAdapter = new VideoAdapter(wikiOutputDir);

  const dryRun = options?.dryRun ?? false;
  const batchSize = options?.batchSize ?? sources.length;
  const batch = sources.slice(0, batchSize);

  // Step 3-4: Process each source
  for (const sourcePath of batch) {
    try {
      let content: string;
      try {
        content = fs.readFileSync(sourcePath, "utf-8");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`read error: ${sourcePath}: ${msg}`);
        result.skipped++;
        continue;
      }

      const frontmatter = parseFrontmatter(content);
      const sourceType = frontmatter["type"] ?? "video";

      // Select adapter based on type
      let output: { content: string; frontmatter: Record<string, string>; suggestedPath: string };
      if (sourceType === "video") {
        output = videoAdapter.compile({ sourcePath, content, frontmatter, termCache });
      } else {
        // Unknown type — skip with note
        result.skipped++;
        continue;
      }

      // Build output frontmatter block
      const fmLines = Object.entries(output.frontmatter)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
      let outputContent = `---\n${fmLines}\n---\n\n${output.content.replace(/^---[\s\S]*?---\r?\n?/, "")}`;

      // Step 4a: Add authorship marking
      const authorshipConfig = config.authorship
        ? {
            agent_name: config.authorship.agent_name,
            created_by_field: config.authorship.created_by_field,
            modified_by_field: config.authorship.modified_by_field,
          }
        : DEFAULT_AUTHORSHIP;
      outputContent = addAuthorship(outputContent, authorshipConfig);

      if (!dryRun) {
        // Ensure output directory exists
        const outDir = path.dirname(output.suggestedPath);
        if (outDir && outDir !== ".") {
          fs.mkdirSync(outDir, { recursive: true });
        }

        // Write output file
        fs.writeFileSync(output.suggestedPath, outputContent, "utf-8");

        // Step 4b: Update source status from "todo" to "compiled"
        const updatedSource = setFrontmatterField(content, "status", "compiled");
        fs.writeFileSync(sourcePath, updatedSource, "utf-8");
      }

      result.processed++;
      result.outputs.push(output.suggestedPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`compile error: ${sourcePath}: ${msg}`);
      result.skipped++;
    }
  }

  return result;
}
