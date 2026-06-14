import { describe, it, expect } from "vitest";
import {
  createStubAnalyzerProvider,
  runAnalysis,
} from "./analyzer.js";
import { prepareCleanRoom } from "./clean-room.js";
import type { DistillTarget, AnalyzerResult } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpec(name: string, content: string) {
  const target: DistillTarget = { name, content };
  return prepareCleanRoom(target);
}

// ---------------------------------------------------------------------------
// AnalyzerResult JSON schema
// ---------------------------------------------------------------------------

describe("AnalyzerResult JSON schema (stub provider)", () => {
  const stub = createStubAnalyzerProvider();

  it("stub provider has a model identifier", () => {
    expect(stub.model).toBe("stub");
  });

  it("returns an object with patterns, risks, attribution", async () => {
    const spec = makeSpec("test", "some content");
    const result = await stub.analyze(spec);
    expect(result).toHaveProperty("patterns");
    expect(result).toHaveProperty("risks");
    expect(result).toHaveProperty("attribution");
  });

  it("patterns is an array", async () => {
    const result = await stub.analyze(makeSpec("t", "hello"));
    expect(Array.isArray(result.patterns)).toBe(true);
  });

  it("risks is an array", async () => {
    const result = await stub.analyze(makeSpec("t", "hello"));
    expect(Array.isArray(result.risks)).toBe(true);
  });

  it("attribution has repo, url, license_note strings", async () => {
    const result = await stub.analyze(makeSpec("t", "hello"));
    expect(typeof result.attribution.repo).toBe("string");
    expect(typeof result.attribution.url).toBe("string");
    expect(typeof result.attribution.license_note).toBe("string");
  });

  it("each pattern has file (string), line (number), description (string), absorb_confidence (0–1)", async () => {
    const content = "embedBatch Promise.all parallel pool";
    const result = await stub.analyze(makeSpec("qmd-test", content));
    for (const p of result.patterns) {
      expect(typeof p.file).toBe("string");
      expect(typeof p.line).toBe("number");
      expect(typeof p.description).toBe("string");
      expect(p.absorb_confidence).toBeGreaterThanOrEqual(0);
      expect(p.absorb_confidence).toBeLessThanOrEqual(1);
    }
  });

  it("each risk has description (string) and severity in allowed set", async () => {
    const content = "GPL-3.0 license detected here";
    const result = await stub.analyze(makeSpec("gpl-test", content));
    for (const r of result.risks) {
      expect(typeof r.description).toBe("string");
      expect(["low", "medium", "high", "critical"]).toContain(r.severity);
    }
  });

  it("patterns are sorted descending by absorb_confidence", async () => {
    const content =
      "embedBatch Promise.all parallel\nLeiden Louvain community\nsha256 fingerprint";
    const result = await stub.analyze(makeSpec("multi", content));
    for (let i = 1; i < result.patterns.length; i++) {
      expect(result.patterns[i - 1]!.absorb_confidence).toBeGreaterThanOrEqual(
        result.patterns[i]!.absorb_confidence,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// runAnalysis orchestration
// ---------------------------------------------------------------------------

describe("runAnalysis", () => {
  it("calls provider and returns validated result", async () => {
    const stub = createStubAnalyzerProvider();
    const spec = makeSpec("orch-test", "embedBatch parallel pool");
    const result = await runAnalysis(spec, stub);
    expect(result.patterns.length).toBeGreaterThan(0);
  });

  it("throws if provider returns non-array patterns", async () => {
    const badProvider = {
      model: "bad",
      async analyze(): Promise<AnalyzerResult> {
        return { patterns: "bad" as unknown as [], risks: [], attribution: { repo: "", url: "", license_note: "" } };
      },
    };
    const spec = makeSpec("bad", "x");
    await expect(runAnalysis(spec, badProvider)).rejects.toThrow("patterns must be an array");
  });

  it("throws if absorb_confidence is out of range", async () => {
    const badProvider = {
      model: "bad",
      async analyze(): Promise<AnalyzerResult> {
        return {
          patterns: [{ file: "f", line: 1, description: "d", absorb_confidence: 1.5 }],
          risks: [],
          attribution: { repo: "", url: "", license_note: "" },
        };
      },
    };
    await expect(runAnalysis(makeSpec("bad", "x"), badProvider)).rejects.toThrow(
      "absorb_confidence",
    );
  });

  it("throws if severity is invalid", async () => {
    const badProvider = {
      model: "bad",
      async analyze(): Promise<AnalyzerResult> {
        return {
          patterns: [],
          risks: [{ description: "r", severity: "unknown" as "low" }],
          attribution: { repo: "", url: "", license_note: "" },
        };
      },
    };
    await expect(runAnalysis(makeSpec("bad", "x"), badProvider)).rejects.toThrow("severity");
  });
});

// ---------------------------------------------------------------------------
// Known-pattern detection (qmd absorption ledger)
// ---------------------------------------------------------------------------

describe("known patterns — qmd absorption ledger", () => {
  const stub = createStubAnalyzerProvider();

  it("detects hardware-adaptive parallel pool (P-01)", async () => {
    const result = await stub.analyze(makeSpec("qmd", "embedBatch Promise.all parallel"));
    const descriptions = result.patterns.map((p) => p.description);
    expect(descriptions.some((d) => /parallel/i.test(d))).toBe(true);
  });

  it("detects SHA-256 fingerprint pattern", async () => {
    const result = await stub.analyze(makeSpec("qmd", "sha256 fingerprint incremental"));
    const descriptions = result.patterns.map((p) => p.description);
    expect(descriptions.some((d) => /SHA-256|fingerprint/i.test(d))).toBe(true);
  });

  it("detects sqlite-vec store pattern", async () => {
    const result = await stub.analyze(makeSpec("qmd", "sqlite-vec vec0 store lazy-load"));
    const descriptions = result.patterns.map((p) => p.description);
    expect(descriptions.some((d) => /sqlite-vec/i.test(d))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Known-pattern detection (graphify absorption ledger)
// ---------------------------------------------------------------------------

describe("known patterns — graphify absorption ledger", () => {
  const stub = createStubAnalyzerProvider();

  it("detects 4-pass entity deduplication", async () => {
    const result = await stub.analyze(makeSpec("graphify", "deduplicate_entities MinHash JW"));
    const descriptions = result.patterns.map((p) => p.description);
    expect(descriptions.some((d) => /dedup|deduplication/i.test(d))).toBe(true);
  });

  it("detects Leiden/Louvain community detection", async () => {
    const result = await stub.analyze(makeSpec("graphify", "Leiden Louvain community cluster"));
    const descriptions = result.patterns.map((p) => p.description);
    expect(descriptions.some((d) => /Leiden|community/i.test(d))).toBe(true);
  });

  it("detects grow-only build_merge pattern", async () => {
    const result = await stub.analyze(makeSpec("graphify", "build_merge grow-only incremental"));
    const descriptions = result.patterns.map((p) => p.description);
    expect(descriptions.some((d) => /build_merge|grow-only/i.test(d))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Risk detection
// ---------------------------------------------------------------------------

describe("risk detection", () => {
  const stub = createStubAnalyzerProvider();

  it("flags GPL-3.0 as high severity", async () => {
    const result = await stub.analyze(makeSpec("gpl-test", "This uses GPL-3.0 license"));
    const high = result.risks.filter((r) => r.severity === "high");
    expect(high.some((r) => /GPL/i.test(r.description))).toBe(true);
  });

  it("flags setInterval as stateful pattern", async () => {
    const result = await stub.analyze(makeSpec("state-test", "setInterval(() => {}, 1000)"));
    const high = result.risks.filter((r) => r.severity === "high");
    expect(high.some((r) => /stateful|setInterval/i.test(r.description))).toBe(true);
  });

  it("flags [UNVERIFIED] patterns as high severity", async () => {
    const result = await stub.analyze(makeSpec("unverified", "[UNVERIFIED] some pattern"));
    const high = result.risks.filter((r) => r.severity === "high");
    expect(high.some((r) => /UNVERIFIED/i.test(r.description))).toBe(true);
  });
});
