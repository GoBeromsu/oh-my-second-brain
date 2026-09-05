import { describe, expect, it } from "vitest";
import { formatLintReport } from "./report.js";

describe("formatLintReport", () => {
  it("summarizes broken links and orphans deterministically", () => {
    const output = formatLintReport({ totalNotes: 3, brokenLinks: [{ notePath: "b.md", target: "Missing" }, { notePath: "a.md", target: "Gone" }], orphanPaths: ["c.md"] }, { vault: "/vault" });
    expect(output).toContain("Scanned 3 notes");
    expect(output.indexOf("a.md")).toBeLessThan(output.indexOf("b.md"));
    expect(output).toContain("[[Missing]]");
    expect(output).toContain("c.md");
  });

  it("reports a clean result", () => {
    const output = formatLintReport({ totalNotes: 1, brokenLinks: [], orphanPaths: [] }, { vault: "/vault" });
    expect(output).toContain("Broken wikilinks: 0");
    expect(output).toContain("Orphan notes: 0");
  });

  it("caps details unless verbose", () => {
    const result = { totalNotes: 2, brokenLinks: Array.from({ length: 6 }, (_, index) => ({ notePath: "a.md", target: `T${index}` })), orphanPaths: ["a.md", "b.md"] };
    expect(formatLintReport(result, { vault: "/vault" })).toContain("and 1 more");
    expect(formatLintReport(result, { vault: "/vault" })).toContain("Run `oms link check --verbose`");
    expect(formatLintReport(result, { vault: "/vault" })).not.toContain("oms lint");
    expect(formatLintReport(result, { vault: "/vault", verbose: true })).toContain("[[T5]]");
    expect(formatLintReport(result, { vault: "/vault", verbose: true })).not.toContain("Run `oms link check --verbose`");
  });
});
