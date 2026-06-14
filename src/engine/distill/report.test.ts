import { describe, it, expect } from "vitest";
import { generateReport } from "./report.js";
import type { AnalyzerResult } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_RESULT: AnalyzerResult = {
  patterns: [
    {
      file: "src/llm.ts",
      line: 1000,
      description: "Hardware-adaptive parallel embedding context pool",
      absorb_confidence: 0.95,
    },
    {
      file: "src/store.ts",
      line: 42,
      description: "SHA-256 incremental fingerprint",
      absorb_confidence: 0.92,
    },
    {
      file: "dedup.py",
      line: 10,
      description: "4-pass entity deduplication pipeline",
      absorb_confidence: 0.88,
    },
  ],
  risks: [
    { description: "GPL-3.0 detected", severity: "high" },
    { description: "Hardcoded vault path", severity: "medium" },
    { description: "Minor naming inconsistency", severity: "low" },
  ],
  attribution: {
    repo: "github.com/tobi/qmd",
    url: "https://github.com/tobi/qmd",
    license_note: "MIT",
  },
};

const EMPTY_RESULT: AnalyzerResult = {
  patterns: [],
  risks: [],
  attribution: {
    repo: "unknown",
    url: "",
    license_note: "unconfirmed",
  },
};

// ---------------------------------------------------------------------------
// 3-section completeness
// ---------------------------------------------------------------------------

describe("generateReport — 3-section completeness", () => {
  it("report contains §1 Patterns section", () => {
    const report = generateReport(FULL_RESULT, "qmd");
    expect(report).toContain("## §1 Patterns");
  });

  it("report contains §2 Risks section", () => {
    const report = generateReport(FULL_RESULT, "qmd");
    expect(report).toContain("## §2 Risks");
  });

  it("report contains §3 Attribution section", () => {
    const report = generateReport(FULL_RESULT, "qmd");
    expect(report).toContain("## §3 Attribution");
  });

  it("all 3 sections present even when patterns and risks are empty", () => {
    const report = generateReport(EMPTY_RESULT, "empty-target");
    expect(report).toContain("## §1 Patterns");
    expect(report).toContain("## §2 Risks");
    expect(report).toContain("## §3 Attribution");
  });

  it("sections appear in order: §1, §2, §3", () => {
    const report = generateReport(FULL_RESULT, "qmd");
    const pos1 = report.indexOf("## §1 Patterns");
    const pos2 = report.indexOf("## §2 Risks");
    const pos3 = report.indexOf("## §3 Attribution");
    expect(pos1).toBeLessThan(pos2);
    expect(pos2).toBeLessThan(pos3);
  });
});

// ---------------------------------------------------------------------------
// §1 Patterns — ranking and content
// ---------------------------------------------------------------------------

describe("§1 Patterns", () => {
  it("includes all pattern descriptions", () => {
    const report = generateReport(FULL_RESULT, "qmd");
    for (const p of FULL_RESULT.patterns) {
      expect(report).toContain(p.description);
    }
  });

  it("patterns appear in confidence-descending order in the report", () => {
    // Pre-sort descending (as analyzer would deliver)
    const sorted = [...FULL_RESULT.patterns].sort(
      (a, b) => b.absorb_confidence - a.absorb_confidence,
    );
    const report = generateReport(FULL_RESULT, "qmd");
    let lastIdx = -1;
    for (const p of sorted) {
      const idx = report.indexOf(p.description);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it("includes file:line location for patterns with line > 0", () => {
    const report = generateReport(FULL_RESULT, "qmd");
    expect(report).toContain("src/llm.ts:1000");
  });

  it("shows 'No patterns identified' when list is empty", () => {
    const report = generateReport(EMPTY_RESULT, "empty");
    expect(report).toContain("No patterns identified");
  });

  it("includes absorb confidence percentage", () => {
    const report = generateReport(FULL_RESULT, "qmd");
    expect(report).toContain("95%"); // 0.95 * 100
  });
});

// ---------------------------------------------------------------------------
// §2 Risks — content and severity ordering
// ---------------------------------------------------------------------------

describe("§2 Risks", () => {
  it("includes all risk descriptions", () => {
    const report = generateReport(FULL_RESULT, "qmd");
    for (const r of FULL_RESULT.risks) {
      expect(report).toContain(r.description);
    }
  });

  it("HIGH risk appears before MEDIUM and LOW in report", () => {
    const report = generateReport(FULL_RESULT, "qmd");
    const highPos = report.indexOf("GPL-3.0 detected");
    const medPos = report.indexOf("Hardcoded vault path");
    const lowPos = report.indexOf("Minor naming inconsistency");
    expect(highPos).toBeLessThan(medPos);
    expect(medPos).toBeLessThan(lowPos);
  });

  it("shows 'No risks identified' when list is empty", () => {
    const report = generateReport(EMPTY_RESULT, "empty");
    expect(report).toContain("No risks identified");
  });

  it("includes severity badge text for high risk", () => {
    const report = generateReport(FULL_RESULT, "qmd");
    expect(report).toContain("[HIGH]");
  });

  it("includes severity badge text for medium risk", () => {
    const report = generateReport(FULL_RESULT, "qmd");
    expect(report).toContain("[MEDIUM]");
  });
});

// ---------------------------------------------------------------------------
// §3 Attribution
// ---------------------------------------------------------------------------

describe("§3 Attribution", () => {
  it("includes repo name", () => {
    const report = generateReport(FULL_RESULT, "qmd");
    expect(report).toContain("github.com/tobi/qmd");
  });

  it("includes URL when present", () => {
    const report = generateReport(FULL_RESULT, "qmd");
    expect(report).toContain("https://github.com/tobi/qmd");
  });

  it("includes license note", () => {
    const report = generateReport(FULL_RESULT, "qmd");
    expect(report).toContain("MIT");
  });

  it("includes ACKNOWLEDGMENTS.md reference", () => {
    const report = generateReport(FULL_RESULT, "qmd");
    expect(report).toContain("ACKNOWLEDGMENTS.md");
  });

  it("includes 'NOT a license gate' disclaimer", () => {
    const report = generateReport(FULL_RESULT, "qmd");
    expect(report).toMatch(/NOT a license gate/i);
  });

  it("includes target name in header", () => {
    const report = generateReport(FULL_RESULT, "my-target-name");
    expect(report).toContain("my-target-name");
  });

  it("handles empty URL gracefully", () => {
    const report = generateReport(EMPTY_RESULT, "no-url");
    expect(report).toContain("## §3 Attribution");
    expect(report).toContain("unconfirmed");
  });
});

// ---------------------------------------------------------------------------
// No side effects
// ---------------------------------------------------------------------------

describe("generateReport — no side effects", () => {
  it("does not mutate the input AnalyzerResult", () => {
    const original = JSON.stringify(FULL_RESULT);
    generateReport(FULL_RESULT, "qmd");
    expect(JSON.stringify(FULL_RESULT)).toBe(original);
  });

  it("returns a string (not void, not Promise)", () => {
    const result = generateReport(FULL_RESULT, "qmd");
    expect(typeof result).toBe("string");
  });
});
