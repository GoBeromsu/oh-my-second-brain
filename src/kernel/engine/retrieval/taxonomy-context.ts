import { loadResolvedTemplatesIfPresent } from "../../templates/resolver.js";
import type { GlobalAxis, JsonValue } from "../../templates/types.js";

export interface TaxonomyIntentProvenance {
  readonly folder: string;
  readonly intent: string;
  /** The sole source allowed to contribute prompt text. */
  readonly source: ".oms/taxonomy.json";
}

export interface TaxonomyIntentProjection {
  readonly matched: readonly TaxonomyIntentProvenance[];
  readonly indexedWithoutIntent: readonly string[];
  readonly taxonomyWithoutIndexed: readonly string[];
  readonly warnings: readonly string[];
  /** Deterministic prompt fragment, or undefined when no intent matched. */
  readonly promptContext?: string;
}

function compareText(left: string, right: string): number {
  // localeCompare changes order across ICU/locale versions. Code-point order is
  // intentionally boring and reproducible in benchmark receipts.
  return left < right ? -1 : left > right ? 1 : 0;
}

function topLevelFolder(relativePath: string): string | undefined {
  const normalized = relativePath.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
  const slash = normalized.indexOf("/");
  if (slash <= 0) return undefined; // root-level notes have no folder intent
  const folder = normalized.slice(0, slash);
  return folder.startsWith(".") ? undefined : folder;
}

/**
 * Pure projection from active taxonomy intents and indexed document paths.
 *
 * `collectionPath`, when present, scopes prompt context and warnings to that
 * top-level folder. A global query receives every matched intent, matching qmd's
 * collection/global context behavior without creating a second context store.
 */
export function projectTaxonomyIntents(
  intents: ReadonlyMap<string, string>,
  indexedPaths: readonly string[],
  collectionPath?: string,
): TaxonomyIntentProjection {
  const indexed = new Set<string>();
  for (const documentPath of indexedPaths) {
    const folder = topLevelFolder(documentPath);
    if (folder !== undefined) indexed.add(folder);
  }

  const scopedFolder = collectionPath === undefined
    ? undefined
    : topLevelFolder(`${collectionPath.replace(/\\/gu, "/")}/placeholder.md`);
  const relevant = (folder: string): boolean => scopedFolder === undefined || folder === scopedFolder;

  const matched = [...indexed]
    .filter(relevant)
    .flatMap((folder): TaxonomyIntentProvenance[] => {
      const intent = intents.get(folder)?.trim();
      return intent === undefined || intent === ""
        ? []
        : [{ folder, intent, source: ".oms/taxonomy.json" }];
    })
    .sort((left, right) => compareText(left.folder, right.folder));

  const indexedWithoutIntent = [...indexed]
    .filter(relevant)
    .filter((folder) => intents.get(folder)?.trim() === undefined || intents.get(folder)?.trim() === "")
    .sort(compareText);

  const taxonomyWithoutIndexed = [...intents.keys()]
    .filter(relevant)
    .filter((folder) => !indexed.has(folder))
    .sort(compareText);

  const warnings = [
    ...indexedWithoutIntent.map((folder) =>
      `Indexed folder "${folder}" has no intent in .oms/taxonomy.json.`),
    ...taxonomyWithoutIndexed.map((folder) =>
      `Taxonomy folder "${folder}" has no indexed Markdown files.`),
  ];

  return {
    matched,
    indexedWithoutIntent,
    taxonomyWithoutIndexed,
    warnings,
    ...(matched.length === 0
      ? {}
      : { promptContext: matched.map(({ folder, intent }) => `- ${folder}: ${intent}`).join("\n") }),
  };
}

function folderOntologyIntents(axis: GlobalAxis | undefined): ReadonlyMap<string, string> {
  if (axis?.kind !== "folder") return new Map();
  const extensionIntents = axis.extensions?.["intents"];
  if (typeof extensionIntents !== "object" || extensionIntents === null || Array.isArray(extensionIntents)) {
    return new Map();
  }
  const declaredIntents = extensionIntents as Readonly<Record<string, JsonValue>>;
  const intents = new Map<string, string>();
  for (const member of axis.members) {
    if (typeof member !== "string") continue;
    const intent = declaredIntents[member];
    if (typeof intent === "string" && intent.trim() !== "") intents.set(member, intent.trim());
  }
  return intents;
}

/** Resolves model context from the active, verified template contract. */
export async function loadTaxonomyIntentProjection(
  vault: string,
  indexedPaths: readonly string[],
  collectionPath?: string,
): Promise<TaxonomyIntentProjection> {
  let convention: Awaited<ReturnType<typeof loadResolvedTemplatesIfPresent>>;
  try {
    convention = await loadResolvedTemplatesIfPresent(vault);
  } catch (error: unknown) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    throw new Error(`${diagnostic} Run oms doctor --vault <vault> to repair the active template contract.`);
  }
  if (convention === null) return projectTaxonomyIntents(new Map(), indexedPaths, collectionPath);
  return projectTaxonomyIntents(
    folderOntologyIntents(convention.globalAxes["folder-ontology"]),
    indexedPaths,
    collectionPath,
  );
}
