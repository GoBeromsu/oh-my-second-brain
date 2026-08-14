import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOntology } from "../core/ontology/loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// src/ontology/ → repo root is two levels up
const repoRoot = path.resolve(__dirname, "../../");
const ontologyDir = path.join(repoRoot, "core", "ontology");

describe("loadOntology", () => {
  it("loads taxonomy with version === 1", async () => {
    const ontology = await loadOntology(ontologyDir);
    expect(ontology.taxonomy.version).toBe(1);
  });

  it("has a 'literature' concept with 4 fields including required title and source-url", async () => {
    const ontology = await loadOntology(ontologyDir);
    const lit = ontology.concepts.get("literature");
    expect(lit).toBeDefined();
    expect(lit!.fields).toHaveLength(4);

    const titleField = lit!.fields.find((f) => f.name === "title");
    expect(titleField).toBeDefined();
    expect(titleField!.required).toBe(true);

    const urlField = lit!.fields.find((f) => f.name === "source-url");
    expect(urlField).toBeDefined();
    expect(urlField!.required).toBe(true);
  });

  it("literature concept has a 'synthesis' lens", async () => {
    const ontology = await loadOntology(ontologyDir);
    const lit = ontology.concepts.get("literature");
    expect(lit).toBeDefined();
    const synthesisLens = (lit!.lenses ?? []).find((l) => l.name === "synthesis");
    expect(synthesisLens).toBeDefined();
  });

  it("has an 'inbox' concept", async () => {
    const ontology = await loadOntology(ontologyDir);
    expect(ontology.concepts.has("inbox")).toBe(true);
  });

  it("taxonomy.folders has references, notes, and inbox", async () => {
    const ontology = await loadOntology(ontologyDir);
    expect(ontology.taxonomy.folders).toHaveProperty("references");
    expect(ontology.taxonomy.folders).toHaveProperty("notes");
    expect(ontology.taxonomy.folders).toHaveProperty("inbox");
  });
});
