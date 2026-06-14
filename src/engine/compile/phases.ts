/**
 * Atomicstrata 2-phase separation for compile execution.
 *
 * CONCEPT-ONLY: The 2-phase approach (extract-all-without-writing → generate)
 * is absorbed from atomicstrata as a conceptual pattern.  No verbatim code.
 *
 * Phase A = extract-all-without-writing
 *   Pure read: load all material files from disk.  Zero vault mutation.
 *
 * Phase B = generate
 *   LLM synthesis writes to the processed/ tier ONLY.  Never writes to wiki/
 *   directly.  Promotion from processed/ → wiki/ is the collection owner's
 *   responsibility (M3).
 *
 * Hard constraint: Phase A and Phase B NEVER overlap in the same execution
 * context.  Enforced by a module-level phase lock.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FolderGradeMap, PhaseAResult } from "./types.js";
import { applyGrades } from "./provenance.js";

// ---------------------------------------------------------------------------
// Phase lock (prevents A+B overlap in one execution context)
// ---------------------------------------------------------------------------

type ActivePhase = "none" | "A" | "B";
let _activePhase: ActivePhase = "none";

function acquirePhase(phase: "A" | "B"): void {
  if (_activePhase !== "none") {
    throw new Error(
      `Phase ${phase} cannot start while Phase ${_activePhase} is active. ` +
        `Phase A and Phase B must never overlap in the same execution context.`,
    );
  }
  _activePhase = phase;
}

function releasePhase(): void {
  _activePhase = "none";
}

/**
 * Reset the phase lock.  For testing only — allows sequential phase tests
 * without process restart.
 */
export function resetPhaseLock(): void {
  _activePhase = "none";
}

// ---------------------------------------------------------------------------
// Phase A — extract-all-without-writing (pure read)
// ---------------------------------------------------------------------------

/**
 * Phase A: load all material files from disk and apply provenance grades.
 *
 * Pure read — no vault mutation.  The phase lock prevents Phase B from
 * starting while Phase A is running.
 *
 * @param materialPaths - Vault-relative paths to load.
 * @param vaultPath     - Absolute path to vault root.
 * @param gradeMap      - Folder->grade map resolved at setup time.
 */
export async function phaseA(
  materialPaths: ReadonlyArray<string>,
  vaultPath: string,
  gradeMap: FolderGradeMap,
): Promise<PhaseAResult> {
  acquirePhase("A");
  try {
    const rawMaterials = await Promise.all(
      materialPaths.map(async (relPath) => {
        const abs = path.join(vaultPath, relPath);
        const text = await readFile(abs, "utf8");
        return { path: relPath, text };
      }),
    );
    const materials = applyGrades(rawMaterials, gradeMap);
    return { materials };
  } finally {
    releasePhase();
  }
}

// ---------------------------------------------------------------------------
// Phase B — generate (writes to processed/ tier only)
// ---------------------------------------------------------------------------

/**
 * Phase B: write synthesized output to the processed/ tier.
 *
 * NEVER writes to wiki/ directly.  The path guard enforces the tier boundary:
 * if `processedDir` contains "/wiki/" or ends with "/wiki", an error is thrown.
 *
 * @param conceptId    - Concept identifier used as the output filename (no extension).
 * @param body         - Synthesized Markdown body from the CoT pipeline.
 * @param processedDir - Absolute path to the processed/ output directory.
 * @param writeFn      - Injected write function; defaults replaced in tests for isolation.
 * @returns Absolute path to the written file.
 */
export async function phaseB(
  conceptId: string,
  body: string,
  processedDir: string,
  writeFn: (filePath: string, content: string) => Promise<void>,
): Promise<string> {
  acquirePhase("B");
  try {
    // Tier boundary guard: processed/ must not resolve to wiki/
    const normalised = processedDir.replace(/\\/g, "/");
    if (
      normalised.includes("/wiki/") ||
      normalised.endsWith("/wiki")
    ) {
      throw new Error(
        `Phase B: processedDir "${processedDir}" resolves to the wiki/ tier. ` +
          `Phase B must write ONLY to the processed/ tier. ` +
          `Promotion from processed/ to wiki/ is the collection owner's responsibility.`,
      );
    }

    const outputPath = path.join(processedDir, `${conceptId}.md`);
    await writeFn(outputPath, body);
    return outputPath;
  } finally {
    releasePhase();
  }
}
