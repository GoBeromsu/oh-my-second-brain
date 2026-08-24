import { describe, it, expect } from "vitest";
import { validateFrontmatter } from "./validate.js";
import type { Concept } from "../ontology/types.js";

const literatureConcept: Concept = {
  concept: "literature",
  intent: "A processed reference.",
  folder: "references",
  fields: [
    { name: "title", type: "string", required: true, intent: "Title of the work." },
    { name: "source-url", type: "url", required: true, intent: "Canonical URL." },
    { name: "author", type: "list", required: false, intent: "Authors." },
    { name: "tags", type: "list", required: false, intent: "Tags.", normalize: "kebab" },
  ],
  lenses: [
    { name: "synthesis", intent: "Synthesis lens.", fields: ["title", "source-url"] },
  ],
};

describe("validateFrontmatter", () => {
  it("returns valid:true for a complete, correctly typed literature note", () => {
    const fm: Record<string, unknown> = {
      title: "Clean Architecture",
      "source-url": "https://www.oreilly.com/library/view/clean-architecture-a/9780134494272/",
      author: ["Robert C. Martin"],
      tags: ["software-architecture", "design"],
    };
    const result = validateFrontmatter(fm, literatureConcept);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("reports a required violation when title is missing", () => {
    const fm: Record<string, unknown> = {
      "source-url": "https://example.com",
    };
    const result = validateFrontmatter(fm, literatureConcept);
    expect(result.valid).toBe(false);
    const v = result.violations.find((x) => x.field === "title");
    expect(v).toBeDefined();
    expect(v?.rule).toBe("required");
  });

  it("reports a required violation when title is an empty string", () => {
    const fm: Record<string, unknown> = {
      title: "",
      "source-url": "https://example.com",
    };
    const result = validateFrontmatter(fm, literatureConcept);
    const v = result.violations.find((x) => x.field === "title");
    expect(v?.rule).toBe("required");
  });

  it("reports a type violation when title is a number", () => {
    const fm: Record<string, unknown> = {
      title: 42,
      "source-url": "https://example.com",
    };
    const result = validateFrontmatter(fm, literatureConcept);
    const v = result.violations.find((x) => x.field === "title");
    expect(v).toBeDefined();
    expect(v?.rule).toBe("type");
  });

  it("reports a type violation when source-url is not a valid URL", () => {
    const fm: Record<string, unknown> = {
      title: "Some Book",
      "source-url": "not-a-url",
    };
    const result = validateFrontmatter(fm, literatureConcept);
    const v = result.violations.find((x) => x.field === "source-url");
    expect(v).toBeDefined();
    expect(v?.rule).toBe("type");
  });

  it("reports a type violation when tags is a string instead of a list", () => {
    const fm: Record<string, unknown> = {
      title: "Some Book",
      "source-url": "https://example.com",
      tags: "not-a-list",
    };
    const result = validateFrontmatter(fm, literatureConcept);
    const v = result.violations.find((x) => x.field === "tags");
    expect(v).toBeDefined();
    expect(v?.rule).toBe("type");
  });

  it("does NOT report a violation for undeclared extra keys", () => {
    const fm: Record<string, unknown> = {
      title: "Some Book",
      "source-url": "https://example.com",
      "extra-custom-field": "some value",
      unknown: 123,
    };
    const result = validateFrontmatter(fm, literatureConcept);
    const extraViolations = result.violations.filter(
      (v) => v.field === "extra-custom-field" || v.field === "unknown",
    );
    expect(extraViolations).toHaveLength(0);
  });

  it("never throws", () => {
    expect(() =>
      validateFrontmatter(
        { title: null, "source-url": undefined } as Record<string, unknown>,
        literatureConcept,
      ),
    ).not.toThrow();
  });
});
