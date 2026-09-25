import { describe, expect, it } from "vitest";
import { PATTERN_SOURCE_LIMIT, patternRefusal } from "./pattern.js";

describe("pattern screen", () => {
  it("accepts a source at the length cap and refuses one past it", () => {
    expect(patternRefusal("a".repeat(PATTERN_SOURCE_LIMIT))).toBeNull();
    expect(patternRefusal("a".repeat(PATTERN_SOURCE_LIMIT + 1))).toBe("too-long");
  });

  it("names why a source cannot be sealed", () => {
    expect(patternRefusal("")).toBe("empty");
    expect(patternRefusal("(")).toBe("invalid");
    expect(patternRefusal("(a+)+")).toBe("nested");
    expect(patternRefusal("[a-z]+-\\d{4}")).toBeNull();
  });

  it("checks the length before compiling, so a long invalid source is too-long", () => {
    expect(patternRefusal("(".repeat(PATTERN_SOURCE_LIMIT + 1))).toBe("too-long");
  });
});
