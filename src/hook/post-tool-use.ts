import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildGraphCache } from "../graph/cache.js";
import { loadOntology } from "../ontology/loader.js";
import { parseNote } from "../conventions/frontmatter.js";
import { validateFrontmatter } from "../conventions/validate.js";
import { resolveConcept } from "../ontology/resolver.js";
import { readStdinTimeout } from "./stdin.js";

/** Debounce window for graph builds, in seconds. */
export const GRAPH_BUILD_DEBOUNCE_SECS = 300;

/** Timestamp filename inside <vault>/.oms/cache/. */
export const DEBOUNCE_STAMP_NAME = ".last-graph-build";

interface PostToolUsePayload {
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
}

/**
 * Return age (seconds) of the debounce stamp, or null if it does not exist.
 */
export async function getDebounceAgeSeconds(vault: string): Promise<number | null> {
  const stampPath = path.join(vault, ".oms", "cache", DEBOUNCE_STAMP_NAME);
  try {
    const s = await stat(stampPath);
    return (Date.now() - s.mtimeMs) / 1000;
  } catch {
    return null;
  }
}

export async function touchDebounceStamp(vault: string): Promise<void> {
  const stampDir = path.join(vault, ".oms", "cache");
  await mkdir(stampDir, { recursive: true });
  await writeFile(path.join(stampDir, DEBOUNCE_STAMP_NAME), new Date().toISOString(), "utf-8");
}

/**
 * Run a frontmatter audit on a just-written note and return any violation lines.
 * Returns an empty array when there are no violations or when audit is not possible.
 */
export async function auditNote(
  vault: string,
  relPath: string,
): Promise<string[]> {
  try {
    const absPath = path.join(vault, relPath);
    const raw = await readFile(absPath, "utf-8");
    const { frontmatter } = parseNote(raw);

    const localOntologyDir = path.join(vault, ".oms");
    let ontology;
    try {
      ontology = await loadOntology(localOntologyDir);
    } catch {
      return [];
    }

    const concept = resolveConcept(ontology, relPath);
    if (!concept) return [];

    const result = validateFrontmatter(frontmatter, concept);
    if (result.violations.length === 0) return [];

    const lines = [`[oms-audit] ${relPath} (concept: ${concept.concept}):`];
    for (const v of result.violations) {
      lines.push(`  [${v.rule}] ${v.message}`);
    }
    return lines;
  } catch {
    return [];
  }
}

export async function runPostToolUse(opts: { vault: string }): Promise<void> {
  const vault = path.resolve(opts.vault);

  let rawInput: string;
  try {
    rawInput = await readStdinTimeout();
  } catch {
    return; // fail-open
  }

  let payload: PostToolUsePayload;
  try {
    payload = JSON.parse(rawInput) as PostToolUsePayload;
  } catch {
    return; // fail-open
  }

  const toolName = (payload.tool_name ?? payload.toolName ?? "").toLowerCase();
  if (toolName !== "write" && toolName !== "edit") return;

  const toolInput = payload.tool_input ?? {};
  const rawFilePath = String(toolInput["path"] ?? toolInput["file_path"] ?? "");
  if (!rawFilePath) return;

  const absFilePath = path.isAbsolute(rawFilePath) ? rawFilePath : path.resolve(rawFilePath);
  const relPath = path.relative(vault, absFilePath).replace(/\\/g, "/");

  if (relPath.startsWith("..") || path.isAbsolute(relPath)) return;
  if (!relPath.endsWith(".md")) return;

  // Frontmatter audit — report violations as additionalContext.
  const auditLines = await auditNote(vault, relPath);
  if (auditLines.length > 0) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: auditLines.join("\n"),
        },
      }) + "\n",
    );
  }

  // Graph build with 300-second debounce.
  try {
    const ageSecs = await getDebounceAgeSeconds(vault);
    if (ageSecs !== null && ageSecs < GRAPH_BUILD_DEBOUNCE_SECS) {
      return; // built recently, skip
    }

    await touchDebounceStamp(vault);

    const localOntologyDir = path.join(vault, ".oms");
    let ontology;
    try {
      ontology = await loadOntology(localOntologyDir);
    } catch {
      return; // no ontology → skip graph build
    }

    await buildGraphCache({ vault, ontology, write: true });
  } catch {
    // graph build failure is non-blocking
  }
}
