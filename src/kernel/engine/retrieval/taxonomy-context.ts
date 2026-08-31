import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export interface TaxonomyIntentProvenance {
  readonly folder: string;
  readonly intent: string;
  /** The sole source allowed to contribute prompt text. */
  readonly source: ".oms/taxonomy.yaml";
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
        : [{ folder, intent, source: ".oms/taxonomy.yaml" }];
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
      `Indexed folder "${folder}" has no intent in .oms/taxonomy.yaml.`),
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

function parseFolderIntents(raw: string): ReadonlyMap<string, string> {
  const parsed: unknown = parseYaml(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Map();
  const folders = (parsed as Record<string, unknown>)["folders"];
  if (typeof folders !== "object" || folders === null || Array.isArray(folders)) return new Map();
  const intents = new Map<string, string>();
  for (const [folder, binding] of Object.entries(folders as Record<string, unknown>)) {
    if (typeof binding !== "object" || binding === null || Array.isArray(binding)) continue;
    const intent = (binding as Record<string, unknown>)["intent"];
    if (typeof intent === "string" && intent.trim() !== "") intents.set(folder, intent.trim());
  }
  return intents;
}

/** Read only the active user-owned taxonomy; never fall back to a parallel SSOT. */
export async function loadTaxonomyIntentProjection(
  vault: string,
  indexedPaths: readonly string[],
  collectionPath?: string,
): Promise<TaxonomyIntentProjection> {
  let intents: ReadonlyMap<string, string> = new Map();
  let sourceWarning: string | undefined;
  try {
    intents = parseFolderIntents(
      await readFile(path.join(vault, ".oms", "taxonomy.yaml"), "utf8"),
    );
  } catch {
    // Query remains available. The receipt makes the missing semantic input
    // explicit instead of silently substituting bundled or legacy context.
    sourceWarning = "Active taxonomy context .oms/taxonomy.yaml is unavailable or invalid.";
  }
  const projection = projectTaxonomyIntents(intents, indexedPaths, collectionPath);
  return sourceWarning === undefined
    ? projection
    : { ...projection, warnings: [sourceWarning, ...projection.warnings] };
}

/** Synchronous status-path twin; query execution uses the async loader above. */
export function loadTaxonomyIntentProjectionSync(
  vault: string,
  indexedPaths: readonly string[],
): TaxonomyIntentProjection {
  let intents: ReadonlyMap<string, string> = new Map();
  let sourceWarning: string | undefined;
  try {
    intents = parseFolderIntents(
      readFileSync(path.join(vault, ".oms", "taxonomy.yaml"), "utf8"),
    );
  } catch {
    sourceWarning = "Active taxonomy context .oms/taxonomy.yaml is unavailable or invalid.";
  }
  const projection = projectTaxonomyIntents(intents, indexedPaths);
  return sourceWarning === undefined
    ? projection
    : { ...projection, warnings: [sourceWarning, ...projection.warnings] };
}
