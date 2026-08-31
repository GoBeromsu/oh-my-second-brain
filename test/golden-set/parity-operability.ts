/**
 * Operability instrumentation for a real-vault parity run.
 *
 * `parity-gate.ts` can *judge* operability, but judging requires numbers, and the
 * R2 harness never produced them: it recorded query latency and nothing about
 * memory, embedding wall time, or whether the vector count it wrote matched the
 * corpus it read. A gate with no measurement behind it is decoration, so this
 * module supplies the missing half.
 *
 * The distinction from relevance is deliberate and load-bearing. These numbers
 * answer "did the run survive the corpus at all?" — a question that a fast,
 * stable, completely irrelevant engine also passes. They are therefore collected
 * and reported separately, never blended into a single score.
 */

import { percentile } from "./harness.js";

/** Counts a run reports about the corpus it processed. */
export interface CorpusCounts {
  readonly scanned: number;
  readonly indexed: number;
  readonly skipped: number;
  readonly errors: number;
  readonly vectorCount: number;
  readonly expectedVectorCount: number;
}

export interface OperabilitySample {
  readonly exitCode: number;
  readonly peakRssBytes: number;
  readonly embedWallMs: number;
  readonly plainQueryP95Ms: number;
  readonly precisionQueryP95Ms?: number;
}

export type OperabilityMeasurement = CorpusCounts & OperabilitySample;

/** Injectable clock and memory probe, so tests never depend on real timing. */
export interface OperabilityProbes {
  readonly now: () => number;
  readonly rss: () => number;
}

const defaultProbes: OperabilityProbes = {
  now: () => Date.now(),
  rss: () => process.memoryUsage().rss,
};

/**
 * Track peak resident memory across an operation.
 *
 * Node exposes only instantaneous RSS, so a peak has to be sampled. Sampling on
 * an interval alone would be unreliable for a short operation and would report
 * zero for one that finishes between ticks, so this samples at the start, at the
 * end, and on every explicit `mark()` — and the caller is expected to mark inside
 * its own loop, where the real high-water mark occurs.
 *
 * A peak of zero is never reported as success by the gate: zero means nothing was
 * measured, which is missing evidence rather than a frugal run.
 */
export class PeakRssTracker {
  private peak = 0;
  private readonly probes: OperabilityProbes;

  constructor(probes: Partial<OperabilityProbes> = {}) {
    this.probes = { ...defaultProbes, ...probes };
    this.mark();
  }

  /** Sample now and retain the maximum seen so far. */
  mark(): number {
    const current = this.probes.rss();
    if (!Number.isFinite(current) || current < 0) {
      throw new Error(`RSS probe returned an unusable value: ${String(current)}`);
    }
    if (current > this.peak) this.peak = current;
    return current;
  }

  get peakBytes(): number {
    return this.peak;
  }
}

/**
 * Time an async operation while tracking peak memory across it.
 *
 * The tracker is passed into the operation so a long loop can mark its own
 * high-water point; without that, a run whose memory spikes mid-embed and settles
 * before returning would report a peak it never actually reached.
 *
 * A rejection is deliberately not swallowed. An operability measurement of a run
 * that failed is not a measurement of a successful run, and silently returning
 * partial numbers would let a crashed embed pass as a slow one.
 */
export async function measureOperation<T>(
  operation: (tracker: PeakRssTracker) => Promise<T>,
  probes: Partial<OperabilityProbes> = {},
): Promise<{ readonly result: T; readonly wallMs: number; readonly peakRssBytes: number }> {
  const resolved: OperabilityProbes = { ...defaultProbes, ...probes };
  const tracker = new PeakRssTracker(resolved);
  const started = resolved.now();
  const result = await operation(tracker);
  const wallMs = resolved.now() - started;
  tracker.mark();
  if (wallMs < 0) throw new Error(`clock went backwards during measurement: ${wallMs} ms`);
  return { result, wallMs, peakRssBytes: tracker.peakBytes };
}

/**
 * p95 of a latency series.
 *
 * The percentile itself is delegated to the harness's existing `percentile`, not
 * reimplemented: two copies of one statistic drift, and then a run's reported p95
 * depends on which module computed it. Delegation also inherits the harness's
 * empty-input and non-finite rejection, so absent evidence stays loud — a p95 of
 * zero would read as an impossibly fast run and quietly satisfy the latency bound.
 *
 * The one added constraint is non-negativity, which `percentile` does not impose
 * because it is a general-purpose helper. A negative latency is not a fast query,
 * it is a broken clock, and it must not be averaged into a passing number.
 */
export function p95(values: readonly number[]): number {
  if (values.length === 0) throw new Error("p95 requires at least one latency sample");
  if (values.some((value) => value < 0)) {
    throw new Error("latency samples must be non-negative");
  }
  return percentile(values, 0.95);
}

/** Assemble a complete measurement, validating the pieces are self-consistent. */
export function buildOperabilityMeasurement(input: {
  readonly exitCode: number;
  readonly counts: CorpusCounts;
  readonly embedWallMs: number;
  readonly peakRssBytes: number;
  readonly plainQueryLatenciesMs: readonly number[];
  readonly precisionQueryLatenciesMs?: readonly number[];
}): OperabilityMeasurement {
  const { counts } = input;
  for (const [field, value] of Object.entries(counts)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`operability count ${field} must be a non-negative integer, got ${String(value)}`);
    }
  }
  if (!Number.isInteger(input.exitCode)) {
    throw new Error(`exit code must be an integer, got ${String(input.exitCode)}`);
  }
  if (!Number.isFinite(input.embedWallMs) || input.embedWallMs < 0) {
    throw new Error("embed wall time must be a non-negative number of milliseconds");
  }
  if (!Number.isFinite(input.peakRssBytes) || input.peakRssBytes < 0) {
    throw new Error("peak RSS must be a non-negative number of bytes");
  }
  return {
    ...counts,
    exitCode: input.exitCode,
    embedWallMs: input.embedWallMs,
    peakRssBytes: input.peakRssBytes,
    plainQueryP95Ms: p95(input.plainQueryLatenciesMs),
    ...(input.precisionQueryLatenciesMs === undefined ||
      input.precisionQueryLatenciesMs.length === 0
      ? {}
      : { precisionQueryP95Ms: p95(input.precisionQueryLatenciesMs) }),
  };
}
