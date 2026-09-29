import type { VaultContract } from "../contract/types.js";

/**
 * Stage 2 of the evaluator: the meanings of the candidate contract, read-only and
 * deterministic. It is an advisory filter: a rejection is final, a pass proves nothing
 * (stage 1 and the direction classifier are the hard gates).
 *
 *   - MECE: two entries of one axis whose meanings are near-identical overlap. Only a pair
 *     that involves an entry the candidate adds or re-words counts, so an overlap already
 *     sealed in the parent never blocks every later evolution.
 *   - Drift: the mean, over the entries of the gen-1 anchor, of how far the candidate moved
 *     each meaning (1 - similarity; a removed entry moved all the way). Above 0.3 rejects.
 *
 * Similarity is token Jaccard over lowercased letter/number runs; it is injectable.
 */

export const DRIFT_THRESHOLD = 0.3;
export const OVERLAP_THRESHOLD = 0.9;
const EPSILON = 1e-9;

export type Similarity = (left: string, right: string) => number;
export type MeaningAxis = "folder" | "property";

export interface Overlap {
  readonly axis: MeaningAxis;
  readonly keys: readonly [string, string];
  readonly similarity: number;
}

export interface SemanticResult {
  readonly overlaps: readonly Overlap[];
  /** 0 when the anchor has no entries. */
  readonly drift: number;
  readonly passed: boolean;
  readonly reason?: "mece-overlap" | "drift";
}

function tokens(text: string): Set<string> {
  return new Set(text.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

export function tokenJaccard(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function meanings(contract: VaultContract, axis: MeaningAxis): Map<string, string> {
  const entries = axis === "folder" ? contract.folders : contract.properties;
  return new Map(Object.entries(entries ?? {}).map(([key, entry]) => [key, entry.meaning]));
}

const AXES: readonly MeaningAxis[] = ["folder", "property"];

function overlaps(parent: VaultContract, candidate: VaultContract, similarity: Similarity): Overlap[] {
  const found: Overlap[] = [];
  for (const axis of AXES) {
    const before = meanings(parent, axis);
    const entries = [...meanings(candidate, axis)].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const touched = (key: string, meaning: string): boolean => before.get(key) !== meaning;
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const [leftKey, leftMeaning] = entries[i] as [string, string];
        const [rightKey, rightMeaning] = entries[j] as [string, string];
        if (!touched(leftKey, leftMeaning) && !touched(rightKey, rightMeaning)) continue;
        const score = similarity(leftMeaning, rightMeaning);
        if (score >= OVERLAP_THRESHOLD - EPSILON) found.push({ axis, keys: [leftKey, rightKey], similarity: score });
      }
    }
  }
  return found;
}

function drift(anchor: VaultContract, candidate: VaultContract, similarity: Similarity): number {
  let total = 0;
  let count = 0;
  for (const axis of AXES) {
    const now = meanings(candidate, axis);
    for (const [key, meaning] of meanings(anchor, axis)) {
      const current = now.get(key);
      total += current === undefined ? 1 : 1 - similarity(meaning, current);
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

export function semanticStage(
  anchor: VaultContract,
  parent: VaultContract,
  candidate: VaultContract,
  options: { readonly similarity?: Similarity } = {},
): SemanticResult {
  const similarity = options.similarity ?? tokenJaccard;
  const found = overlaps(parent, candidate, similarity);
  const moved = drift(anchor, candidate, similarity);
  if (found.length > 0) return { overlaps: found, drift: moved, passed: false, reason: "mece-overlap" };
  if (moved > DRIFT_THRESHOLD + EPSILON) return { overlaps: found, drift: moved, passed: false, reason: "drift" };
  return { overlaps: found, drift: moved, passed: true };
}
