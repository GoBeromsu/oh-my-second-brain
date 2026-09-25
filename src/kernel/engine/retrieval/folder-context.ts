import { deriveFolderOntologyAxis } from "../../contract/folders-axis.js";
import type { FolderContract } from "../../contract/types.js";
import { resolveSealState } from "../../contract/vault-id.js";

/** The sole source allowed to contribute folder meaning to a model prompt. */
export const FOLDER_CONTEXT_SOURCE = "folders.json";

export interface FolderIntentProvenance {
  readonly folder: string;
  readonly intent: string;
  readonly source: typeof FOLDER_CONTEXT_SOURCE;
}

export interface FolderIntentProjection {
  readonly matched: readonly FolderIntentProvenance[];
  readonly indexedWithoutIntent: readonly string[];
  readonly foldersWithoutIndexed: readonly string[];
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
 * Pure projection from sealed folder meanings and indexed document paths.
 *
 * `collectionPath`, when present, scopes prompt context and warnings to that
 * top-level folder. A global query receives every matched intent, matching qmd's
 * collection/global context behavior without creating a second context store.
 */
export function projectFolderIntents(
  intents: ReadonlyMap<string, string>,
  indexedPaths: readonly string[],
  collectionPath?: string,
): FolderIntentProjection {
  const indexed = new Set<string>();
  for (const documentPath of indexedPaths) {
    const folder = topLevelFolder(documentPath);
    if (folder !== undefined) indexed.add(folder);
  }

  const scopedFolder = collectionPath === undefined
    ? undefined
    : topLevelFolder(`${collectionPath.replace(/\\/gu, "/")}/placeholder.md`);
  const relevant = (folder: string): boolean => scopedFolder === undefined || folder === scopedFolder;
  const intentOf = (folder: string): string | undefined => {
    const intent = intents.get(folder)?.trim();
    return intent === undefined || intent === "" ? undefined : intent;
  };

  const matched = [...indexed]
    .filter(relevant)
    .flatMap((folder): FolderIntentProvenance[] => {
      const intent = intentOf(folder);
      return intent === undefined ? [] : [{ folder, intent, source: FOLDER_CONTEXT_SOURCE }];
    })
    .sort((left, right) => compareText(left.folder, right.folder));

  const indexedWithoutIntent = [...indexed]
    .filter(relevant)
    .filter((folder) => intentOf(folder) === undefined)
    .sort(compareText);

  const foldersWithoutIndexed = [...intents.keys()]
    .filter(relevant)
    .filter((folder) => !indexed.has(folder))
    .sort(compareText);

  const warnings = [
    ...indexedWithoutIntent.map((folder) =>
      `Indexed folder "${folder}" has no meaning in the sealed folder contract.`),
    ...foldersWithoutIndexed.map((folder) =>
      `Sealed folder "${folder}" has no indexed Markdown files.`),
  ];

  return {
    matched,
    indexedWithoutIntent,
    foldersWithoutIndexed,
    warnings,
    ...(matched.length === 0
      ? {}
      : { promptContext: matched.map(({ folder, intent }) => `- ${folder}: ${intent}`).join("\n") }),
  };
}

/** Top-level folder meanings from the sealed contract; nested contract folders never reach the prompt. */
export function folderIntents(folders: Readonly<Record<string, FolderContract>> | null): ReadonlyMap<string, string> {
  const axis = deriveFolderOntologyAxis(folders);
  const intents = new Map<string, string>();
  if (axis === null) return intents;
  for (const member of axis.members) {
    if (member.includes("/")) continue;
    const intent = axis.extensions.intents[member];
    if (intent !== undefined) intents.set(member, intent);
  }
  return intents;
}

function isAbsent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/**
 * Reads sealed folder meaning without admitting or judging a write. An unsealed
 * vault has no folder meaning; an unreadable seal is reported, never guessed.
 */
export async function loadFolderIntentProjection(
  vault: string,
  indexedPaths: readonly string[],
  collectionPath?: string,
): Promise<FolderIntentProjection> {
  let folders: Readonly<Record<string, FolderContract>> | null = null;
  try {
    const view = (await resolveSealState(vault)).view;
    if (view.state === "unreadable") throw new Error("the sealed contract is unreadable; run oms contract doctor");
    if (view.state === "sealed") folders = view.contract.folders;
  } catch (error: unknown) {
    if (!isAbsent(error)) {
      throw new Error(`FOLDER_CONTEXT_INVALID: ${FOLDER_CONTEXT_SOURCE}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return projectFolderIntents(folderIntents(folders), indexedPaths, collectionPath);
}
