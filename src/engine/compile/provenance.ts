/**
 * Provenance grade resolution and synthesis context weighting.
 *
 * Grade derives from a folder->grade map resolved at setup-time (never hardcoded).
 * In synthesis context: authored weight is raised to preserve individual voice.
 * Priority: authored > curated > external-raw.
 *
 * Self-authored pattern from bstack `terminology` skill.
 */

import type { FolderGradeMap, Material, ProvenanceGrade } from "./types.js";

// ---------------------------------------------------------------------------
// Grade order (index = priority; lower index = higher priority)
// ---------------------------------------------------------------------------

const GRADE_ORDER: ReadonlyArray<ProvenanceGrade> = [
  "authored",
  "curated",
  "external-raw",
];

// ---------------------------------------------------------------------------
// Grade resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the provenance grade of a vault-relative document path using
 * the folder->grade map.  Longest-prefix match wins.
 *
 * Falls back to "external-raw" when no prefix matches.
 */
export function resolveGrade(docPath: string, map: FolderGradeMap): ProvenanceGrade {
  let bestMatch = "";
  let bestGrade: ProvenanceGrade = "external-raw";
  for (const [folder, grade] of Object.entries(map)) {
    // Normalize: treat "notes/" and "notes" identically
    const prefix = folder.endsWith("/") ? folder : `${folder}/`;
    const matches = docPath.startsWith(prefix) || docPath === folder;
    if (matches && folder.length > bestMatch.length) {
      bestMatch = folder;
      bestGrade = grade;
    }
  }
  return bestGrade;
}

/**
 * Apply a grade map to a list of raw materials, returning Material[] with
 * the `grade` field populated.
 */
export function applyGrades(
  materials: ReadonlyArray<{ path: string; text: string }>,
  map: FolderGradeMap,
): Material[] {
  return materials.map((m) => ({
    path: m.path,
    text: m.text,
    grade: resolveGrade(m.path, map),
  }));
}

// ---------------------------------------------------------------------------
// Synthesis context weighting
// ---------------------------------------------------------------------------

/**
 * Numeric weight per grade for synthesis context ordering.
 * Authored is weighted highest (3) to preserve individual voice.
 */
export const GRADE_WEIGHTS: Readonly<Record<ProvenanceGrade, number>> = {
  authored: 3,
  curated: 2,
  "external-raw": 1,
};

/**
 * Sort materials so authored items appear first in the synthesis context,
 * followed by curated, then external-raw.  Stable sort within each grade.
 */
export function sortByProvenance(materials: ReadonlyArray<Material>): Material[] {
  return [...materials].sort(
    (a, b) => GRADE_WEIGHTS[b.grade] - GRADE_WEIGHTS[a.grade],
  );
}

/**
 * Return the dominant (highest-priority) grade among the given materials.
 * Returns "external-raw" for an empty array.
 */
export function dominantGrade(materials: ReadonlyArray<Material>): ProvenanceGrade {
  if (materials.length === 0) return "external-raw";
  let best: ProvenanceGrade = "external-raw";
  for (const m of materials) {
    if (GRADE_ORDER.indexOf(m.grade) < GRADE_ORDER.indexOf(best)) {
      best = m.grade;
    }
  }
  return best;
}

/**
 * Format materials for the synthesis LLM prompt, ordered by provenance weight.
 * Authored items are labelled to signal individual-voice preservation.
 */
export function formatForSynthesis(materials: ReadonlyArray<Material>): string {
  const sorted = sortByProvenance(materials);
  return sorted
    .map((m) => {
      const label =
        m.grade === "authored"
          ? "[AUTHORED — preserve individual voice]"
          : m.grade === "curated"
            ? "[CURATED]"
            : "[EXTERNAL]";
      return `${label}\nSource: ${m.path}\n${m.text}`;
    })
    .join("\n\n---\n\n");
}
