/**
 * Ambiguity scoring for the Socratic setup interview.
 *
 * Self-reimplementation of the omc deep-interview methodology — method only, no code copied.
 * Formula: ambiguity = 1 − mean(goal, constraint, criteria, context)
 */

import type { DimensionScore, InterviewConfig } from "./types.js";

/**
 * Compute ambiguity from a set of scoring sub-dimensions.
 *
 * ambiguity = 1 − mean(goal, constraint, criteria, context)
 *
 * Returns a value in [0, 1]:
 *   0 — fully resolved (no ambiguity)
 *   1 — completely ambiguous (no sub-dimension scored)
 *
 * Returns 1 if scores is empty (worst-case: treat unknown as maximally ambiguous).
 */
export function computeAmbiguity(scores: DimensionScore): number {
  const values = Object.values(scores) as number[];
  if (values.length === 0) return 1;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return 1 - mean;
}

/**
 * Returns true when a dimension's ambiguity is at or below the configured threshold —
 * i.e. the dimension is resolved enough to proceed to the challenge phase.
 */
export function meetsThreshold(
  scores: DimensionScore,
  config: Pick<InterviewConfig, "ambiguityThreshold">
): boolean {
  return computeAmbiguity(scores) <= config.ambiguityThreshold;
}

/** Validation error for a single sub-dimension. */
export interface ScoreValidationError {
  subDimension: string;
  message: string;
}

/** Result of validating a DimensionScore. */
export interface ScoreValidationResult {
  valid: boolean;
  errors: ScoreValidationError[];
}

/**
 * Validate that all four scoring sub-dimensions are present and in [0, 1].
 * Returns a typed validation result (never throws).
 */
export function validateScores(scores: DimensionScore): ScoreValidationResult {
  const required: Array<keyof DimensionScore> = ["goal", "constraint", "criteria", "context"];
  const errors: ScoreValidationError[] = [];

  for (const key of required) {
    const val = scores[key];
    if (typeof val !== "number" || Number.isNaN(val) || val < 0 || val > 1) {
      errors.push({
        subDimension: key,
        message: `must be a finite number in [0, 1], got ${val}`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}
