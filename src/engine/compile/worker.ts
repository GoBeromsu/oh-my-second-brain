/**
 * Stateless compile worker — M2 core entry point.
 *
 * compile(opts) → CascadeResult
 *
 * Fully stateless: the only side effect is the SHA cache write to disk.
 * No daemon, no watcher, no persistent process (R2).
 *
 * Flow:
 *   1. Compute input-material fingerprint SHA.
 *   2. Load SHA cache; diff against stored SHA.
 *   3. Unchanged SHA → return skip sentinel (body = "").
 *   4. Changed / new SHA → run nashsu 2-step CoT via cot.ts.
 *   5. Enrich with lucasastorian cascade backlinks.
 *   6. Persist updated SHA to cache.
 *
 * SHA-incremental pattern: bstack `terminology` skill (self-authored, Steps 2-4).
 */

import type {
  CascadeResult,
  CompileGraph,
  CompileResult,
  FolderGradeMap,
  LLMProvider,
  Material,
  ProvenanceGrade,
} from "./types.js";
import { diffSHA, fingerprint, loadSHACache, saveSHACache } from "./sha-cache.js";
import { formatForSynthesis } from "./provenance.js";
import { runCoT } from "./cot.js";
import { withCascade } from "./cascade.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for a single compile run. */
export interface CompileOptions {
  /** Human-readable concept name (used in LLM prompts). */
  concept: string;
  /** Pre-graded material items.  Use phaseA + applyGrades before calling compile(). */
  materials: Material[];
  /** Graph for cascade backlink resolution.  Use createNullGraph() when unavailable. */
  graph: CompileGraph;
  /** Injected LLM provider.  Use createDeterministicStub() in tests. */
  llm: LLMProvider;
  /** Absolute path to the .llmwiki/ dotfolder (SHA cache location). */
  dotLlmwiki: string;
  /** Stable concept identifier used as SHA cache key (vault-relative path recommended). */
  conceptId: string;
}

// ---------------------------------------------------------------------------
// Compile worker
// ---------------------------------------------------------------------------

/**
 * Stateless compile worker.
 *
 * Returns a CascadeResult.  If the material fingerprint SHA is unchanged
 * since the last compile, returns a skip sentinel: body === "" and
 * wasSkipped(result) === true.
 */
export async function compile(opts: CompileOptions): Promise<CascadeResult> {
  const { concept, materials, graph, llm, dotLlmwiki, conceptId } = opts;

  // Step 1: fingerprint the input materials
  const inputSHA = fingerprint(materials);

  // Step 2: load cache and check for changes (R12 incremental)
  const cache = await loadSHACache(dotLlmwiki);
  const status = diffSHA(cache, conceptId, inputSHA);

  if (status === "unchanged") {
    // Skip: material is identical to the last compile; no recompile needed.
    const skipResult: CompileResult = {
      body: "",
      sha: inputSHA,
      provenance: materials.map((m) => m.grade),
    };
    // Still return cascade info so callers can inspect backlinks
    return withCascade(skipResult, conceptId, graph);
  }

  // Step 3: run nashsu 2-step CoT (analysis → synthesis)
  const formattedMaterials = formatForSynthesis(materials);
  const cotResult = await runCoT(concept, formattedMaterials, llm);

  const provenance: ProvenanceGrade[] = materials.map((m) => m.grade);
  const result: CompileResult = {
    body: cotResult.body,
    sha: inputSHA,
    provenance,
  };

  // Step 4: persist updated SHA before returning
  cache[conceptId] = inputSHA;
  await saveSHACache(dotLlmwiki, cache);

  // Step 5: enrich with lucasastorian cascade backlinks
  return withCascade(result, conceptId, graph);
}

// ---------------------------------------------------------------------------
// Skip sentinel helper
// ---------------------------------------------------------------------------

/**
 * Returns true if the compile output is a cache-hit skip sentinel
 * (i.e., no recompile was performed because the SHA was unchanged).
 */
export function wasSkipped(output: CascadeResult): boolean {
  return output.body === "";
}
