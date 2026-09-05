import { describe, expect, it } from "vitest";
import { formatObsidianTime, parseObsidianTimeFormat, TemplateExpressionError } from "./obsidian-core-time.js";

describe("Obsidian Core Templates time formats", () => {
  const afternoon = new Date(2026, 10, 5, 13, 4, 9);
  const morning = new Date(2001, 0, 2, 0, 3, 7);

  it("renders every supported padded and unpadded token class", () => {
    expect(formatObsidianTime("YYYY YY MM M DD D", afternoon, "date")).toBe("2026 26 11 11 05 5");
    expect(formatObsidianTime("HH H hh h mm m ss s", morning, "time")).toBe("00 0 12 12 03 3 07 7");
  });

  it("renders 12-hour meridiem tokens and all allowed separators", () => {
    expect(formatObsidianTime("hh:mm:ss A a", afternoon, "time")).toBe("01:04:09 PM pm");
    expect(formatObsidianTime("YYYY/MM/DD.HH-mm:ssTYY", afternoon, "date")).toBe("2026/11/05.13-04:09T26");
  });

  it("uses the Core Templates defaults for unformatted date and time tags", () => {
    expect(formatObsidianTime("", afternoon, "date")).toBe("2026-11-05");
    expect(formatObsidianTime("", afternoon, "time")).toBe("13:04");
  });

  it("returns validated tokens and rejects unsupported tokens and bracket escapes", () => {
    expect(parseObsidianTimeFormat("YYYY-MM-DD")).toEqual([
      { kind: "token", value: "YYYY" }, { kind: "literal", value: "-" },
      { kind: "token", value: "MM" }, { kind: "literal", value: "-" },
      { kind: "token", value: "DD" },
    ]);
    for (const format of ["MMM", "ddd", "YYYY[year]", "YYYY_MM_DD", ""]) {
      expect(() => parseObsidianTimeFormat(format)).toThrow(TemplateExpressionError);
    }
  });
});
