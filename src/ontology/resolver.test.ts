import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOntology } from "../core/ontology/loader.js";
import { resolveConcept } from "../core/ontology/resolver.js";
import type { Ontology } from "../core/ontology/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../");
const ontologyDir = path.join(repoRoot, "core", "ontology");

let ontology: Ontology;

beforeAll(async () => {
  ontology = await loadOntology(ontologyDir);
});

describe("resolveConcept", () => {
  it("resolves 'references/clean-architecture.md' to concept 'literature'", () => {
    const concept = resolveConcept(ontology, "references/clean-architecture.md");
    expect(concept).toBeDefined();
    expect(concept!.concept).toBe("literature");
  });

  it("resolves 'notes/idea.md' to concept 'inbox'", () => {
    const concept = resolveConcept(ontology, "notes/idea.md");
    expect(concept).toBeDefined();
    expect(concept!.concept).toBe("inbox");
  });

  it("returns undefined for an unknown folder", () => {
    const concept = resolveConcept(ontology, "unknown-folder/some-note.md");
    expect(concept).toBeUndefined();
  });

  it("normalizes backslashes in note paths", () => {
    const concept = resolveConcept(ontology, "references\\clean-architecture.md");
    expect(concept).toBeDefined();
    expect(concept!.concept).toBe("literature");
  });
});
