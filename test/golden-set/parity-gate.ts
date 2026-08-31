/**
 * The frozen parity gate for the real-vault qmd comparison.
 *
 * Every threshold in this module is a constant, not a tunable. The approved plan
 * fixes them *before* any run so a disappointing result cannot be rescued by
 * moving the bar afterwards; that is the whole point of preregistration. The
 * existing `OMS_GOLDEN_MIN_RECALL` escape hatch is deliberately not honoured
 * here — see {@link assertFrozenThresholds}.
 *
 * Two gates live here and they are kept apart on purpose:
 *
 * - **Relevance** answers "does OMS retrieve the right documents?"
 * - **Operability** answers "does OMS survive the corpus at all?"
 *
 * Passing operability proves the run completed, not that it was any good. A
 * single combined verdict would let a fast, stable, irrelevant engine look like
 * a qualified replacement, so neither gate can satisfy the other.
 */

/** Retrieval modalities scored independently by the relevance gate. */
export const PARITY_MODALITIES = ["lex", "vec", "hyde"] as const;
export type ParityModality = (typeof PARITY_MODALITIES)[number];

/** Metrics the gate requires for every scope. */
export const PARITY_METRICS = ["recallAt10", "ndcgAt10", "mrrAt10"] as const;
export type ParityMetric = (typeof PARITY_METRICS)[number];

/**
 * Frozen per-modality floors. Recorded by the approved plan; changing a value
 * here invalidates every prior run and requires a new preregistration.
 */
export const MODALITY_FLOORS: Readonly<Record<ParityMetric, number>> = {
  recallAt10: 0.8,
  ndcgAt10: 0.7,
  mrrAt10: 0.65,
};

/** Frozen aggregate floors, strictly higher than the per-modality floors. */
export const AGGREGATE_FLOORS: Readonly<Record<ParityMetric, number>> = {
  recallAt10: 0.85,
  ndcgAt10: 0.75,
  mrrAt10: 0.7,
};

/**
 * The worst OMS may trail the matching qmd arm on any metric.
 *
 * Negative by design: OMS is allowed to be very slightly behind, because a
 * demand to win everywhere would fail on noise alone. It may not be *materially*
 * behind, which is what this bounds.
 */
export const MAX_QMD_DEFICIT = -0.02;

/** Minimum curated rows per modality; fewer cannot support a parity claim. */
export const MIN_CURATED_ROWS_PER_MODALITY = 5;

/** Language strata every modality must cover, so parity is not English-only. */
export const REQUIRED_LANGUAGE_STRATA = ["ko", "en-or-mixed"] as const;
export type LanguageStratum = (typeof REQUIRED_LANGUAGE_STRATA)[number];

/** Operability limits. Each is an independent hard bound, not a budget to trade. */
export const OPERABILITY_LIMITS = {
  /** Peak resident set size across the run, in bytes (8 GiB). */
  maxPeakRssBytes: 8 * 1024 * 1024 * 1024,
  /** Wall-clock ceiling for embedding the frozen corpus, in ms (6 hours). */
  maxEmbedWallMs: 6 * 60 * 60 * 1000,
  /** p95 query latency without rerank or expansion, in ms. */
  maxPlainQueryP95Ms: 5_000,
  /** p95 query latency with explicit precision capabilities, in ms. */
  maxPrecisionQueryP95Ms: 30_000,
} as const;

/** Environment variables that must not be able to move a frozen threshold. */
export const FORBIDDEN_THRESHOLD_OVERRIDES = [
  "OMS_GOLDEN_MIN_RECALL",
  "OMS_PARITY_MIN_RECALL",
  "OMS_PARITY_MIN_NDCG",
  "OMS_PARITY_MIN_MRR",
  "OMS_PARITY_MAX_DEFICIT",
] as const;

/** One scope's measured metrics, for OMS and the matching qmd arm. */
export interface ParityScopeMeasurement {
  /** Rows actually scored in this scope. Zero is a hard failure, never a pass. */
  readonly scoredRows: number;
  /** Curated rows available in this scope. */
  readonly curatedRows: number;
  /** Language strata present among this scope's curated rows. */
  readonly languageStrata: readonly LanguageStratum[];
  readonly oms: Readonly<Record<ParityMetric, number>>;
  /** The matching qmd arm. Absent means no comparator ran, which fails. */
  readonly qmd?: Readonly<Record<ParityMetric, number>>;
}

export interface ParityRelevanceInput {
  readonly modalities: Readonly<Partial<Record<ParityModality, ParityScopeMeasurement>>>;
  readonly aggregate: ParityScopeMeasurement;
  /**
   * Modalities this profile is expected to score. The B1 foundation profile
   * omits `hyde`; the B2 parity profile includes it. Stated explicitly so a
   * silently missing modality cannot look like a narrower profile.
   */
  readonly expectedModalities: readonly ParityModality[];
}

export interface OperabilityInput {
  readonly exitCode: number;
  readonly scanned: number;
  readonly indexed: number;
  readonly skipped: number;
  readonly errors: number;
  /** Vectors actually stored. */
  readonly vectorCount: number;
  /** Vectors the corpus should have produced. */
  readonly expectedVectorCount: number;
  readonly peakRssBytes: number;
  readonly embedWallMs: number;
  readonly plainQueryP95Ms: number;
  /** Absent when the profile ran no precision queries. */
  readonly precisionQueryP95Ms?: number;
}

export interface GateVerdict {
  readonly passed: boolean;
  /** Every failed requirement. Populated even when several fail at once. */
  readonly failures: readonly string[];
}

function isFiniteRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Reject any attempt to relax a frozen threshold through the environment.
 *
 * The R2 harness lets `OMS_GOLDEN_MIN_RECALL` set its recall floor, which is
 * fine for a fixture smoke test but fatal for a preregistered comparison: the
 * number that decides the verdict must not be readable from the environment the
 * run happens to execute in. Presence alone fails, before any measurement, so
 * this cannot be discovered only after seeing an inconvenient result.
 */
export function assertFrozenThresholds(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const present = FORBIDDEN_THRESHOLD_OVERRIDES.filter((name) => {
    const raw = env[name];
    return typeof raw === "string" && raw.trim() !== "";
  });
  if (present.length > 0) {
    throw new Error(
      `parity thresholds are frozen and cannot be overridden by the environment: ${present.join(", ")}. ` +
        "Unset these variables; changing a threshold requires a new preregistration, not a runtime flag.",
    );
  }
}

function evaluateScope(
  label: string,
  scope: ParityScopeMeasurement,
  floors: Readonly<Record<ParityMetric, number>>,
  failures: string[],
): void {
  if (scope.scoredRows <= 0) {
    failures.push(`${label}: zero scored rows; an empty scope is a failure, not a pass`);
    return;
  }
  if (scope.scoredRows !== scope.curatedRows) {
    failures.push(
      `${label}: scored ${scope.scoredRows} of ${scope.curatedRows} curated rows; ` +
        "missing or failed comparator rows are a hard failure",
    );
  }
  if (scope.curatedRows < MIN_CURATED_ROWS_PER_MODALITY) {
    failures.push(
      `${label}: ${scope.curatedRows} curated rows is below the frozen minimum of ` +
        `${MIN_CURATED_ROWS_PER_MODALITY}`,
    );
  }
  const strata = new Set(scope.languageStrata);
  const missingStrata = REQUIRED_LANGUAGE_STRATA.filter((stratum) => !strata.has(stratum));
  if (missingStrata.length > 0) {
    failures.push(`${label}: missing required language coverage: ${missingStrata.join(", ")}`);
  }

  for (const metric of PARITY_METRICS) {
    const measured = scope.oms[metric];
    if (!isFiniteRatio(measured)) {
      failures.push(`${label}: ${metric} is not a finite ratio in [0,1]`);
      continue;
    }
    const floor = floors[metric];
    if (measured < floor) {
      failures.push(`${label}: ${metric} ${measured.toFixed(4)} is below the frozen floor ${floor}`);
    }
  }

  if (scope.qmd === undefined) {
    failures.push(
      `${label}: no matching qmd arm was measured; a parity claim requires the comparator, ` +
        "not an OMS-only score",
    );
    return;
  }
  for (const metric of PARITY_METRICS) {
    const mine = scope.oms[metric];
    const theirs = scope.qmd[metric];
    if (!isFiniteRatio(mine) || !isFiniteRatio(theirs)) {
      failures.push(`${label}: ${metric} comparison requires finite OMS and qmd values`);
      continue;
    }
    const delta = mine - theirs;
    if (delta < MAX_QMD_DEFICIT) {
      failures.push(
        `${label}: ${metric} trails qmd by ${(-delta).toFixed(4)}, beyond the frozen ` +
          `allowance of ${(-MAX_QMD_DEFICIT).toFixed(2)}`,
      );
    }
  }
}

/** Evaluate the relevance half of the gate. Operability cannot satisfy it. */
export function evaluateRelevanceGate(input: ParityRelevanceInput): GateVerdict {
  const failures: string[] = [];
  if (input.expectedModalities.length === 0) {
    failures.push("relevance gate requires at least one expected modality");
  }
  for (const modality of input.expectedModalities) {
    const scope = input.modalities[modality];
    if (scope === undefined) {
      failures.push(`modality ${modality}: expected by the profile but not measured`);
      continue;
    }
    evaluateScope(`modality ${modality}`, scope, MODALITY_FLOORS, failures);
  }
  const unexpected = (Object.keys(input.modalities) as ParityModality[]).filter(
    (modality) => !input.expectedModalities.includes(modality),
  );
  for (const modality of unexpected) {
    failures.push(`modality ${modality}: measured but not declared by the profile`);
  }
  evaluateScope("aggregate", input.aggregate, AGGREGATE_FLOORS, failures);
  return { passed: failures.length === 0, failures };
}

/** Evaluate the operability half of the gate. Relevance cannot satisfy it. */
export function evaluateOperabilityGate(input: OperabilityInput): GateVerdict {
  const failures: string[] = [];
  if (input.exitCode !== 0) failures.push(`exit code ${input.exitCode} is not 0`);

  for (const [label, value] of [
    ["scanned", input.scanned],
    ["indexed", input.indexed],
    ["skipped", input.skipped],
    ["errors", input.errors],
    ["vectorCount", input.vectorCount],
    ["expectedVectorCount", input.expectedVectorCount],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      failures.push(`${label} must be a non-negative integer, got ${String(value)}`);
    }
  }
  if (input.errors > 0) failures.push(`${input.errors} file errors were reported`);
  if (Number.isInteger(input.scanned) && Number.isInteger(input.indexed) &&
      Number.isInteger(input.skipped) && input.indexed + input.skipped > input.scanned) {
    failures.push(
      `counts are inconsistent: indexed ${input.indexed} + skipped ${input.skipped} exceeds ` +
        `scanned ${input.scanned}`,
    );
  }
  if (input.vectorCount !== input.expectedVectorCount) {
    failures.push(
      `vector count ${input.vectorCount} does not equal the expected embeddable chunk count ` +
        `${input.expectedVectorCount}`,
    );
  }
  if (!(input.peakRssBytes > 0) || input.peakRssBytes > OPERABILITY_LIMITS.maxPeakRssBytes) {
    failures.push(
      `peak RSS ${input.peakRssBytes} bytes is not within (0, ${OPERABILITY_LIMITS.maxPeakRssBytes}]`,
    );
  }
  if (!(input.embedWallMs >= 0) || input.embedWallMs > OPERABILITY_LIMITS.maxEmbedWallMs) {
    failures.push(
      `embed wall time ${input.embedWallMs} ms exceeds ${OPERABILITY_LIMITS.maxEmbedWallMs} ms`,
    );
  }
  // A run that stored vectors necessarily spent time embedding them. Zero here
  // therefore means the embed phase was never measured — the same missing-evidence
  // failure as a zero peak RSS, and one an upper bound alone cannot catch, since a
  // harness that skipped embedding entirely reports exactly 0 and would otherwise
  // satisfy the six-hour ceiling.
  if (input.vectorCount > 0 && !(input.embedWallMs > 0)) {
    failures.push(
      `embed wall time is ${input.embedWallMs} ms while ${input.vectorCount} vectors were stored; ` +
        "the embed phase was not measured",
    );
  }
  if (!(input.plainQueryP95Ms >= 0) || input.plainQueryP95Ms > OPERABILITY_LIMITS.maxPlainQueryP95Ms) {
    failures.push(
      `plain query p95 ${input.plainQueryP95Ms} ms exceeds ${OPERABILITY_LIMITS.maxPlainQueryP95Ms} ms`,
    );
  }
  if (input.precisionQueryP95Ms !== undefined &&
      (!(input.precisionQueryP95Ms >= 0) ||
        input.precisionQueryP95Ms > OPERABILITY_LIMITS.maxPrecisionQueryP95Ms)) {
    failures.push(
      `precision query p95 ${input.precisionQueryP95Ms} ms exceeds ` +
        `${OPERABILITY_LIMITS.maxPrecisionQueryP95Ms} ms`,
    );
  }
  return { passed: failures.length === 0, failures };
}

export interface ParityGateVerdict {
  readonly passed: boolean;
  readonly relevance: GateVerdict;
  readonly operability: GateVerdict;
  /** True only when the run may support a qmd-replacement claim. */
  readonly mayClaimReplacement: boolean;
  readonly failures: readonly string[];
}

/**
 * Evaluate both halves. The run passes only when each passes on its own terms.
 *
 * `mayClaimReplacement` is returned separately from `passed` so a caller cannot
 * accidentally read "the benchmark completed" as "OMS replaces qmd".
 */
export function evaluateParityGate(
  relevanceInput: ParityRelevanceInput,
  operabilityInput: OperabilityInput,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ParityGateVerdict {
  assertFrozenThresholds(env);
  const relevance = evaluateRelevanceGate(relevanceInput);
  const operability = evaluateOperabilityGate(operabilityInput);
  const passed = relevance.passed && operability.passed;
  return {
    passed,
    relevance,
    operability,
    mayClaimReplacement: passed,
    failures: [...relevance.failures, ...operability.failures],
  };
}
