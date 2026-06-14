import { describe, expect, it } from "vitest";
import {
  applyGrades,
  dominantGrade,
  formatForSynthesis,
  GRADE_WEIGHTS,
  resolveGrade,
  sortByProvenance,
} from "./provenance.js";
import type { Material } from "./types.js";

const gradeMap = {
  "notes/": "authored" as const,
  "curated/": "curated" as const,
};

describe("resolveGrade", () => {
  it("resolves authored for notes/ prefix", () => {
    expect(resolveGrade("notes/ideas.md", gradeMap)).toBe("authored");
  });

  it("resolves curated for curated/ prefix", () => {
    expect(resolveGrade("curated/reference.md", gradeMap)).toBe("curated");
  });

  it("defaults to external-raw when no prefix matches", () => {
    expect(resolveGrade("inbox/raw.md", gradeMap)).toBe("external-raw");
    expect(resolveGrade("external/paper.md", gradeMap)).toBe("external-raw");
  });

  it("longest prefix match wins (notes/personal/ beats notes/)", () => {
    const deepMap = {
      "notes/": "curated" as const,
      "notes/personal/": "authored" as const,
    };
    expect(resolveGrade("notes/personal/diary.md", deepMap)).toBe("authored");
    expect(resolveGrade("notes/work/task.md", deepMap)).toBe("curated");
  });

  it("handles paths without trailing slash in map", () => {
    const map = { "notes": "authored" as const };
    expect(resolveGrade("notes/foo.md", map)).toBe("authored");
  });
});

describe("applyGrades", () => {
  it("applies grade map to all materials", () => {
    const materials = [
      { path: "notes/a.md", text: "content a" },
      { path: "curated/b.md", text: "content b" },
      { path: "inbox/c.md", text: "content c" },
    ];
    const result = applyGrades(materials, gradeMap);
    expect(result[0]!.grade).toBe("authored");
    expect(result[1]!.grade).toBe("curated");
    expect(result[2]!.grade).toBe("external-raw");
  });

  it("preserves path and text fields", () => {
    const materials = [{ path: "notes/x.md", text: "hello" }];
    const result = applyGrades(materials, gradeMap);
    expect(result[0]!.path).toBe("notes/x.md");
    expect(result[0]!.text).toBe("hello");
  });
});

describe("GRADE_WEIGHTS", () => {
  it("authored has the highest weight", () => {
    expect(GRADE_WEIGHTS["authored"]).toBeGreaterThan(GRADE_WEIGHTS["curated"]);
    expect(GRADE_WEIGHTS["curated"]).toBeGreaterThan(GRADE_WEIGHTS["external-raw"]);
  });
});

describe("sortByProvenance", () => {
  it("places authored items first, curated second, external-raw last", () => {
    const materials: Material[] = [
      { path: "inbox/ext.md", text: "e", grade: "external-raw" },
      { path: "curated/c.md", text: "c", grade: "curated" },
      { path: "notes/a.md", text: "a", grade: "authored" },
    ];
    const sorted = sortByProvenance(materials);
    expect(sorted[0]!.grade).toBe("authored");
    expect(sorted[1]!.grade).toBe("curated");
    expect(sorted[2]!.grade).toBe("external-raw");
  });

  it("does not mutate the input array", () => {
    const materials: Material[] = [
      { path: "inbox/x.md", text: "x", grade: "external-raw" },
      { path: "notes/y.md", text: "y", grade: "authored" },
    ];
    const original = [...materials];
    sortByProvenance(materials);
    expect(materials[0]!.grade).toBe(original[0]!.grade);
  });
});

describe("dominantGrade", () => {
  it("returns authored when at least one authored material exists", () => {
    const materials: Material[] = [
      { path: "a.md", text: "", grade: "authored" },
      { path: "b.md", text: "", grade: "external-raw" },
    ];
    expect(dominantGrade(materials)).toBe("authored");
  });

  it("returns curated when no authored but curated present", () => {
    const materials: Material[] = [
      { path: "a.md", text: "", grade: "curated" },
      { path: "b.md", text: "", grade: "external-raw" },
    ];
    expect(dominantGrade(materials)).toBe("curated");
  });

  it("returns external-raw when all materials are external-raw", () => {
    const materials: Material[] = [
      { path: "a.md", text: "", grade: "external-raw" },
      { path: "b.md", text: "", grade: "external-raw" },
    ];
    expect(dominantGrade(materials)).toBe("external-raw");
  });

  it("returns external-raw for empty array", () => {
    expect(dominantGrade([])).toBe("external-raw");
  });
});

describe("formatForSynthesis", () => {
  it("labels authored materials with voice-preservation marker", () => {
    const materials: Material[] = [
      { path: "notes/a.md", text: "my thoughts", grade: "authored" },
    ];
    const formatted = formatForSynthesis(materials);
    expect(formatted).toContain("[AUTHORED — preserve individual voice]");
    expect(formatted).toContain("my thoughts");
    expect(formatted).toContain("Source: notes/a.md");
  });

  it("labels curated materials with [CURATED]", () => {
    const materials: Material[] = [
      { path: "curated/ref.md", text: "reference text", grade: "curated" },
    ];
    expect(formatForSynthesis(materials)).toContain("[CURATED]");
  });

  it("labels external materials with [EXTERNAL]", () => {
    const materials: Material[] = [
      { path: "inbox/raw.md", text: "raw capture", grade: "external-raw" },
    ];
    expect(formatForSynthesis(materials)).toContain("[EXTERNAL]");
  });

  it("authored appears before external in formatted output", () => {
    const materials: Material[] = [
      { path: "inbox/ext.md", text: "external", grade: "external-raw" },
      { path: "notes/auth.md", text: "authored", grade: "authored" },
    ];
    const formatted = formatForSynthesis(materials);
    const authoredIdx = formatted.indexOf("[AUTHORED");
    const externalIdx = formatted.indexOf("[EXTERNAL]");
    expect(authoredIdx).toBeLessThan(externalIdx);
  });
});
