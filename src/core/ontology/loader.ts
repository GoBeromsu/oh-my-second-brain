import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Concept, Ontology, Taxonomy } from "./types.js";

export async function loadOntology(ontologyDir: string): Promise<Ontology> {
  const taxonomyPath = path.join(ontologyDir, "taxonomy.yaml");
  const taxonomyRaw = await readFile(taxonomyPath, "utf-8");
  const taxonomyParsed = parseYaml(taxonomyRaw) as Record<string, unknown>;

  const taxonomy: Taxonomy = {
    version:
      typeof taxonomyParsed["version"] === "number"
        ? taxonomyParsed["version"]
        : 0,
    folders:
      taxonomyParsed["folders"] != null &&
      typeof taxonomyParsed["folders"] === "object" &&
      !Array.isArray(taxonomyParsed["folders"])
        ? (taxonomyParsed["folders"] as Taxonomy["folders"])
        : {},
  };

  const conceptsDir = path.join(ontologyDir, "concepts");
  const entries = await readdir(conceptsDir);
  const yamlFiles = entries.filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"));

  const concepts = new Map<string, Concept>();

  for (const file of yamlFiles) {
    const filePath = path.join(conceptsDir, file);
    const raw = await readFile(filePath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;

    const concept: Concept = {
      concept: typeof parsed["concept"] === "string" ? parsed["concept"] : path.basename(file, path.extname(file)),
      intent: typeof parsed["intent"] === "string" ? parsed["intent"] : "",
      folder: typeof parsed["folder"] === "string" ? parsed["folder"] : "",
      fields: Array.isArray(parsed["fields"]) ? (parsed["fields"] as Concept["fields"]) : [],
      lenses: Array.isArray(parsed["lenses"]) ? (parsed["lenses"] as Concept["lenses"]) : [],
    };

    concepts.set(concept.concept, concept);
  }

  for (const [folder, binding] of Object.entries(taxonomy.folders)) {
    const conceptRef = binding.concept;
    if (conceptRef == null) {
      continue;
    }

    const names = Array.isArray(conceptRef) ? conceptRef : [conceptRef];

    for (const name of names) {
      if (!concepts.has(name)) {
        console.warn(
          `[oms] taxonomy folder "${folder}" references unknown concept "${name}" — skipping.`,
        );
      }
    }
  }

  return { taxonomy, concepts };
}
