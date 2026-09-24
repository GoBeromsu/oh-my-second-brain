import { describe, expect, it } from "vitest";
import { scanContractHeadings } from "./content-contract.js";

// The version-4 body evaluator is gone; V5 admission checks headings in
// contract-check.ts. What survives here is the scanner it calls, so these cases
// pin the scan itself: fence handling, setext opt-in, and the size budgets.
describe("scanContractHeadings", () => {
  it("ignores ATX headings inside fenced code, including longer and unclosed runs", () => {
    const closed = ["```markdown", "# Hidden", "## Hidden", "```", "## Real", "### Notes"].join("\n");
    expect(scanContractHeadings(closed).map(item => item.title)).toEqual(["Real", "Notes"]);

    const onlyInside = ["```", "## Hidden", "```"].join("\n");
    expect(scanContractHeadings(onlyInside)).toEqual([]);

    // A longer opening run is only closed by a run at least as long, so the
    // inner three-backtick line stays content.
    const longer = ["`````", "## Hidden", "```", "## Still hidden", "`````", "## Real"].join("\n");
    expect(scanContractHeadings(longer).map(item => item.title)).toEqual(["Real"]);

    // A tilde closing line with trailing text does not close the fence, so
    // everything after it remains inside the block.
    const unclosed = ["~~~", "## Hidden", "~~~ trailing", "# Also hidden"].join("\n");
    expect(scanContractHeadings(unclosed)).toEqual([]);
  });

  it("records the observed level and line so a wrong-level heading stays distinguishable", () => {
    const body = ["```", "## Hidden", "```", "# Summary", "", "### Sources"].join("\n");
    expect(scanContractHeadings(body)).toEqual([
      { title: "Summary", level: 1, line: 4 },
      { title: "Sources", level: 3, line: 6 },
    ]);
  });

  it("reads setext headings only when the caller opts in", () => {
    const body = ["Summary", "=======", "", "Sources", "-------"].join("\n");
    expect(scanContractHeadings(body)).toEqual([]);
    expect(scanContractHeadings(body, true).map(item => ({ title: item.title, level: item.level }))).toEqual([
      { title: "Summary", level: 1 },
      { title: "Sources", level: 2 },
    ]);
  });

  it("refuses an oversize body instead of scanning unbounded input", () => {
    expect(() => scanContractHeadings("a".repeat(1_048_577))).toThrow("CONTENT_CONTRACT_OVERSIZE");
    expect(() => scanContractHeadings("\n".repeat(100_001))).toThrow("CONTENT_CONTRACT_OVERSIZE");
  });
});
