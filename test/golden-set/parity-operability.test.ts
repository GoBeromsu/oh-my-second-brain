import { describe, expect, it } from "vitest";
import {
  buildOperabilityMeasurement,
  measureOperation,
  p95,
  PeakRssTracker,
  type CorpusCounts,
} from "./parity-operability.js";
import { evaluateOperabilityGate, OPERABILITY_LIMITS } from "./parity-gate.js";
import { percentile } from "./harness.js";

function counts(overrides: Partial<CorpusCounts> = {}): CorpusCounts {
  return {
    scanned: 21_251,
    indexed: 20_959,
    skipped: 292,
    errors: 0,
    vectorCount: 48_100,
    expectedVectorCount: 48_100,
    ...overrides,
  };
}

/** A scripted RSS probe, so a peak is asserted rather than hoped for. */
function scriptedRss(values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

/** A monotonic clock returning the scripted instants in order. */
function scriptedClock(values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

describe("peak RSS tracking", () => {
  it("samples at construction so a short operation still reports a peak", () => {
    const tracker = new PeakRssTracker({ rss: scriptedRss([1_000]) });
    expect(tracker.peakBytes).toBe(1_000);
  });

  it("retains the high-water mark rather than the latest sample", () => {
    // The point of a peak: memory that spiked mid-run and settled before the end
    // must still be reported, or an OOM-adjacent run looks frugal.
    const tracker = new PeakRssTracker({ rss: scriptedRss([100, 9_000, 200]) });
    tracker.mark();
    tracker.mark();
    expect(tracker.peakBytes).toBe(9_000);
  });

  it("returns the current sample from mark() while keeping the peak separate", () => {
    const tracker = new PeakRssTracker({ rss: scriptedRss([100, 5_000, 300]) });
    expect(tracker.mark()).toBe(5_000);
    expect(tracker.mark()).toBe(300);
    expect(tracker.peakBytes).toBe(5_000);
  });

  it("rejects an unusable probe reading instead of recording a bogus peak", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => new PeakRssTracker({ rss: () => bad })).toThrow(/RSS probe returned an unusable value/);
    }
  });
});

describe("measured operations", () => {
  it("reports wall time from the injected clock", async () => {
    const measured = await measureOperation(async () => "done", {
      now: scriptedClock([1_000, 4_500]),
      rss: scriptedRss([10]),
    });
    expect(measured.result).toBe("done");
    expect(measured.wallMs).toBe(3_500);
  });

  it("captures a peak the operation reaches internally", async () => {
    // Without handing the tracker to the operation, a spike that resolves before
    // the operation returns would never be sampled.
    const measured = await measureOperation(
      async (tracker) => {
        tracker.mark();
        tracker.mark();
        return null;
      },
      { now: scriptedClock([0, 10]), rss: scriptedRss([100, 8_000, 150, 150]) },
    );
    expect(measured.peakRssBytes).toBe(8_000);
  });

  it("propagates a failure instead of returning partial numbers", async () => {
    // Operability numbers for a crashed run are not operability numbers for a
    // successful one; swallowing this would let a failed embed pass as a slow one.
    await expect(
      measureOperation(async () => {
        throw new Error("embed died at chunk 9000");
      }, { now: scriptedClock([0, 5]), rss: scriptedRss([10]) }),
    ).rejects.toThrow(/embed died at chunk 9000/);
  });

  it("rejects a clock that moves backwards", async () => {
    await expect(
      measureOperation(async () => null, {
        now: scriptedClock([5_000, 1_000]),
        rss: scriptedRss([10]),
      }),
    ).rejects.toThrow(/clock went backwards/);
  });
});

describe("p95 latency", () => {
  it("delegates to the harness percentile so the two never disagree", () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(p95(samples)).toBe(percentile(samples, 0.95));
  });

  it("interpolates between neighbouring ranks", () => {
    expect(p95([1, 2, 3, 4])).toBeCloseTo(3.85, 10);
  });

  it("refuses an empty series rather than reporting an impossibly fast run", () => {
    expect(() => p95([])).toThrow(/at least one latency sample/);
  });

  it("refuses a negative latency, which is a broken clock and not a fast query", () => {
    expect(() => p95([10, -1])).toThrow(/must be non-negative/);
  });

  it("inherits the harness rejection of non-finite samples", () => {
    expect(() => p95([10, Number.NaN])).toThrow(/finite/);
  });

  it("handles a single sample", () => {
    expect(p95([42])).toBe(42);
  });
});

describe("assembled operability measurement", () => {
  it("builds a complete measurement the gate accepts", () => {
    const measurement = buildOperabilityMeasurement({
      exitCode: 0,
      counts: counts(),
      embedWallMs: 90 * 60 * 1000,
      peakRssBytes: 3 * 1024 * 1024 * 1024,
      plainQueryLatenciesMs: [800, 900, 1_100, 1_250],
      precisionQueryLatenciesMs: [9_000, 12_000, 17_500],
    });
    // The real point of this module: the numbers it produces are exactly the
    // shape the gate judges, so measurement and verdict cannot drift apart.
    expect(evaluateOperabilityGate(measurement)).toEqual({ passed: true, failures: [] });
  });

  it("omits the precision p95 when the profile ran no precision queries", () => {
    for (const precision of [undefined, [] as readonly number[]]) {
      const measurement = buildOperabilityMeasurement({
        exitCode: 0,
        counts: counts(),
        embedWallMs: 1_000,
        peakRssBytes: 1_024,
        plainQueryLatenciesMs: [10],
        precisionQueryLatenciesMs: precision,
      });
      expect(measurement.precisionQueryP95Ms).toBeUndefined();
      expect(evaluateOperabilityGate(measurement).passed).toBe(true);
    }
  });

  it("carries a real failure through to a gate rejection", () => {
    const measurement = buildOperabilityMeasurement({
      exitCode: 137,
      counts: counts({ errors: 4, vectorCount: 40_000 }),
      embedWallMs: OPERABILITY_LIMITS.maxEmbedWallMs + 1,
      peakRssBytes: OPERABILITY_LIMITS.maxPeakRssBytes + 1,
      plainQueryLatenciesMs: [OPERABILITY_LIMITS.maxPlainQueryP95Ms + 1],
    });
    const verdict = evaluateOperabilityGate(measurement);
    expect(verdict.passed).toBe(false);
    // Every independent bound is reported, not just the first one hit.
    const text = verdict.failures.join("\n");
    expect(text).toMatch(/exit code 137/);
    expect(text).toMatch(/4 file errors/);
    expect(text).toMatch(/vector count/);
    expect(text).toMatch(/embed wall time/);
    expect(text).toMatch(/peak RSS/);
    expect(text).toMatch(/plain query p95/);
  });

  it.each([
    "scanned",
    "indexed",
    "skipped",
    "errors",
    "vectorCount",
    "expectedVectorCount",
  ] as const)("rejects a non-integer or negative %s", (field) => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() =>
        buildOperabilityMeasurement({
          exitCode: 0,
          counts: counts({ [field]: bad }),
          embedWallMs: 1,
          peakRssBytes: 1,
          plainQueryLatenciesMs: [1],
        }),
      ).toThrow(new RegExp(`operability count ${field}`));
    }
  });

  it("rejects a non-integer exit code and unusable timing or memory", () => {
    const base = {
      exitCode: 0,
      counts: counts(),
      embedWallMs: 1,
      peakRssBytes: 1,
      plainQueryLatenciesMs: [1],
    };
    expect(() => buildOperabilityMeasurement({ ...base, exitCode: 1.5 }))
      .toThrow(/exit code must be an integer/);
    expect(() => buildOperabilityMeasurement({ ...base, embedWallMs: -1 }))
      .toThrow(/embed wall time must be a non-negative/);
    expect(() => buildOperabilityMeasurement({ ...base, peakRssBytes: Number.NaN }))
      .toThrow(/peak RSS must be a non-negative/);
  });

  it("refuses to build when no plain-query latency was recorded", () => {
    // A run that measured no query latency has not demonstrated query
    // operability at all, so it must not produce a passable measurement.
    expect(() =>
      buildOperabilityMeasurement({
        exitCode: 0,
        counts: counts(),
        embedWallMs: 1,
        peakRssBytes: 1,
        plainQueryLatenciesMs: [],
      }),
    ).toThrow(/at least one latency sample/);
  });

  it("cannot manufacture a passing memory figure from an unmeasured run", () => {
    // Zero RSS reaches the gate as missing evidence, not as a frugal success.
    const measurement = buildOperabilityMeasurement({
      exitCode: 0,
      counts: counts(),
      embedWallMs: 1_000,
      peakRssBytes: 0,
      plainQueryLatenciesMs: [10],
    });
    expect(evaluateOperabilityGate(measurement).passed).toBe(false);
  });
});
