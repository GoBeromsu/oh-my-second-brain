import { describe, expect, it } from "vitest";
import type { Concept } from "../ontology/types.js";
import { evaluateWriteContract } from "./write-contract.js";

const LITERATURE: Concept = {
  concept: "literature",
  intent: "A processed reference.",
  folder: "references",
  fields: [
    { name: "title", type: "string", required: true, intent: "Title." },
    { name: "source-url", type: "url", required: true, intent: "Canonical URL." },
    {
      name: "status",
      type: "string",
      required: false,
      intent: "Publication state.",
      enum: ["draft", "published", "archived"],
    },
  ],
};

const NOTE_PATH = "references/clean-code.md";

describe("evaluateWriteContract", () => {
  it("accepts required fields, a listed enum, and extra keys", () => {
    const result = evaluateWriteContract(
      {
        title: "Clean Code",
        "source-url": "https://example.com/clean-code",
        status: "published",
        "my-rating": 5,
      },
      LITERATURE,
      NOTE_PATH,
      new Set(),
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("reports required and type failures without throwing", () => {
    const result = evaluateWriteContract(
      { title: "   ", "source-url": 12 },
      LITERATURE,
      NOTE_PATH,
      new Set(),
    );
    expect(result.valid).toBe(false);
    expect(result.violations.map((violation) => violation.rule).sort()).toEqual(["required", "type"]);
  });

  it("rejects enum values outside the declared list", () => {
    const result = evaluateWriteContract(
      {
        title: "Clean Code",
        "source-url": "https://example.com/clean-code",
        status: "preview",
      },
      LITERATURE,
      NOTE_PATH,
      new Set(),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({ field: "status", rule: "enum" }),
    ]);
  });

  it("requires created_by only in routing-law strict zones", () => {
    const frontmatter = {
      title: "Clean Code",
      "source-url": "https://example.com/clean-code",
    };
    const open = evaluateWriteContract(frontmatter, LITERATURE, NOTE_PATH, new Set());
    expect(open.valid).toBe(true);

    const strict = evaluateWriteContract(
      frontmatter,
      LITERATURE,
      NOTE_PATH,
      new Set(["references"]),
    );
    expect(strict.valid).toBe(false);
    expect(strict.violations).toEqual([
      expect.objectContaining({ field: "created_by", rule: "routing-law" }),
    ]);
  });
});
