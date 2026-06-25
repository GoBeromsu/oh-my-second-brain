import type { Concept, Ontology } from "./types.js";

export function resolveConcept(
  ontology: Ontology,
  notePath: string,
): Concept | undefined {
  const normalized = notePath.replace(/\\/g, "/");
  const slash = normalized.indexOf("/");
  const folder = slash === -1 ? normalized : normalized.slice(0, slash);

  if (!folder) return undefined;

  const binding = ontology.taxonomy.folders[folder];
  if (!binding) return undefined;

  const conceptRef = binding.concept;
  if (conceptRef == null) return undefined;

  if (Array.isArray(conceptRef)) {
    for (const name of conceptRef) {
      const concept = ontology.concepts.get(name);
      if (concept) return concept;
    }
    return undefined;
  }

  return ontology.concepts.get(conceptRef);
}
