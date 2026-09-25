import type { FolderContract } from "./types.js";

/**
 * The folder-ontology search axis, derived only from the sealed `folders.json`.
 * It carries each folder's path and meaning, which are acceptance-surface facts;
 * no rule or value leaves the store through it.
 */

export interface FolderOntologyAxis {
  readonly kind: "folder";
  readonly key: "folder";
  readonly type: "text";
  readonly intent: string;
  readonly members: readonly string[];
  readonly extensions: { readonly intents: Readonly<Record<string, string>> };
}

export function deriveFolderOntologyAxis(folders: Readonly<Record<string, FolderContract>> | null): FolderOntologyAxis | null {
  if (folders === null) return null;
  const meanings = Object.entries(folders)
    .map(([path, folder]) => ({ path, meaning: folder.meaning.normalize("NFC").trim() }))
    .filter(item => item.meaning.length > 0)
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (meanings.length === 0) return null;
  return {
    kind: "folder",
    key: "folder",
    type: "text",
    intent: "Semantic meanings of vault folders.",
    members: meanings.map(item => item.path),
    extensions: { intents: Object.fromEntries(meanings.map(item => [item.path, item.meaning])) },
  };
}
