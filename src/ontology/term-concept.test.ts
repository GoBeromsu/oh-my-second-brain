import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOntology } from "../core/ontology/loader.js";
import { resolveConcept } from "../core/ontology/resolver.js";
import { validateFrontmatter } from "../conventions/validate.js";
import type { Ontology } from "../core/ontology/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../");
const ontologyDir = path.join(repoRoot, "core", "ontology");

let ontology: Ontology;

beforeAll(async () => {
  ontology = await loadOntology(ontologyDir);
});

describe("term concept", () => {
  it("is loaded as a first-class concept bound to the terms folder", () => {
    // Given the shipped core ontology
    // When the term concept is looked up
    const term = ontology.concepts.get("term");
    // Then it exists and declares the terms folder
    expect(term).toBeDefined();
    expect(term!.folder).toBe("terms");
    expect(term!.intent.length).toBeGreaterThan(0);
  });

  it("declares a required string title field", () => {
    const title = ontology.concepts.get("term")?.fields.find((f) => f.name === "title");
    expect(title).toBeDefined();
    expect(title!.type).toBe("string");
    expect(title!.required).toBe(true);
  });

  it("declares an optional aliases field of type list", () => {
    const aliases = ontology.concepts.get("term")?.fields.find((f) => f.name === "aliases");
    expect(aliases).toBeDefined();
    expect(aliases!.type).toBe("list");
    expect(aliases!.required).toBe(false);
  });

  it("resolves a note under terms/ to the term concept", () => {
    // Given a taxonomy binding for terms/
    // When a note path under terms/ is resolved
    const concept = resolveConcept(ontology, "terms/idempotence.md");
    // Then the term concept is selected
    expect(concept).toBeDefined();
    expect(concept!.concept).toBe("term");
  });

  it("reports a required violation when a term note omits title", () => {
    // Given a term note whose frontmatter has aliases but no title
    const concept = resolveConcept(ontology, "terms/idempotence.md");
    expect(concept).toBeDefined();
    // When it is validated
    const result = validateFrontmatter({ aliases: ["idempotent"] }, concept!);
    // Then the missing title is reported as a required violation, not a crash
    expect(result.valid).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({ field: "title", rule: "required" }),
    ]);
  });

  it("reports a type violation when aliases is not a list", () => {
    const concept = resolveConcept(ontology, "terms/idempotence.md");
    const result = validateFrontmatter({ title: "Idempotence", aliases: "idempotent" }, concept!);
    expect(result.valid).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({ field: "aliases", rule: "type" }),
    ]);
  });

  it("accepts a well-formed term note", () => {
    const concept = resolveConcept(ontology, "terms/idempotence.md");
    const result = validateFrontmatter(
      { title: "Idempotence", aliases: ["idempotent", "idempotency"] },
      concept!,
    );
    expect(result).toEqual({ valid: true, violations: [] });
  });
});
