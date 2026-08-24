import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { loadOntology } from "./ontology/loader.js";
import { resolveConcept } from "./ontology/resolver.js";
import { parseNote } from "./conventions/frontmatter.js";
import { validateFrontmatter } from "./conventions/validate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const ontologyDir = path.join(repoRoot, "core", "ontology");
const fixturePath = path.join(repoRoot, "test", "fixtures", "vault", "references", "clean-architecture.md");

describe("E2E: loadOntology → resolveConcept → parseNote → validateFrontmatter", () => {
  it("validates the clean-architecture fixture as valid with no violations", async () => {
    // 1. Load ontology
    const ontology = await loadOntology(ontologyDir);

    // 2. Resolve concept for the fixture note path
    const concept = resolveConcept(ontology, "references/clean-architecture.md");
    expect(concept).toBeDefined();
    expect(concept!.concept).toBe("literature");

    // 3. Read and parse the fixture note
    const raw = await readFile(fixturePath, "utf-8");
    const { frontmatter, hasFrontmatter } = parseNote(raw);
    expect(hasFrontmatter).toBe(true);

    // 4. Validate frontmatter against the resolved concept
    const result = validateFrontmatter(frontmatter, concept!);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});
