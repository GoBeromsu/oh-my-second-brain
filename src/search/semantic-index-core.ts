import { createHash } from "node:crypto";
import path from "node:path";
import type { SemanticQmdCompatibility, SemanticStorage } from "./semantic-types.js";

export const SEMANTIC_JSON_STORAGE = "oms-native-json";
export const SEMANTIC_SQLITE_STORAGE = "qmd-sqlite";
export const DEFAULT_SEMANTIC_STORAGE: SemanticStorage = SEMANTIC_SQLITE_STORAGE;
export const SEMANTIC_INDEX_VERSION = 1;
export const DEFAULT_SEMANTIC_PATTERN = "**/*.md";
export const JSON_QMD_COMPATIBILITY: SemanticQmdCompatibility = {
  queryDocument: true,
  storage: "metadata-compatible",
  unsupportedInternals: [
    "better-sqlite3 FTS5 tables",
    "sqlite-vec vector extension",
    "node-llama-cpp query expansion and reranking",
    "GGUF model cache",
  ],
};
export const SQLITE_QMD_COMPATIBILITY: SemanticQmdCompatibility = {
  queryDocument: true,
  storage: "metadata-compatible",
  unsupportedInternals: [],
};
export const QMD_COMPATIBILITY = SQLITE_QMD_COMPATIBILITY;

export function normalizeSemanticStorage(storage: SemanticStorage | undefined): SemanticStorage {
  return storage ?? DEFAULT_SEMANTIC_STORAGE;
}

export function normalizeCollection(collection: string | undefined): string {
  const trimmed = collection?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "vault";
}

export function normalizeVaultPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.?\//u, "");
}

export function semanticIndexPath(opts: {
  readonly vault?: string;
  readonly index?: string;
  readonly storage?: SemanticStorage;
}): string {
  const vaultRoot = path.resolve(opts.vault ?? process.cwd());
  if (opts.index?.trim()) {
    const indexPath = opts.index.trim();
    if (path.isAbsolute(indexPath)) {
      throw new Error("OMS semantic index path must be relative to the vault.");
    }
    const resolved = path.resolve(vaultRoot, indexPath);
    const relative = path.relative(vaultRoot, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("OMS semantic index path must stay inside the vault.");
    }
    return resolved;
  }
  const fileName = normalizeSemanticStorage(opts.storage) === SEMANTIC_SQLITE_STORAGE
    ? "semantic-store.sqlite"
    : "semantic-index.json";
  return path.join(vaultRoot, ".oms", fileName);
}

function hash(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

export function semanticDocumentId(collection: string, notePath: string): string {
  return `#${hash(`${collection}\u0000${notePath}`).slice(0, 12)}`;
}

export function semanticDocumentUri(collection: string, notePath: string): string {
  return `oms://${encodeURIComponent(collection)}/${notePath.split("/").map(encodeURIComponent).join("/")}`;
}

export function safeSemanticCollectionPath(vault: string, relativePath: string | undefined): string {
  const raw = relativePath?.trim() || ".";
  if (path.isAbsolute(raw)) throw new Error("OMS semantic collection path must be relative to the vault.");
  const resolved = path.resolve(vault, raw);
  const relative = path.relative(vault, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("OMS semantic collection path must stay inside the vault.");
  }
  return normalizeVaultPath(relative === "" ? "." : relative);
}

function globRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? "";
    const next = pattern[index + 1] ?? "";
    if (char === "*" && next === "*") {
      source += ".*";
      index++;
    } else if (char === "*") {
      source += "[^/]*";
    } else if ("|\\{}()[]^$+?.".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`, "u");
}

export function matchesSemanticPattern(
  notePath: string,
  collectionPath: string,
  pattern: string,
  ignore: readonly string[],
): boolean {
  const collectionRelative = collectionPath === "."
    ? notePath
    : normalizeVaultPath(path.relative(collectionPath, notePath));
  if (collectionRelative === ".." || collectionRelative.startsWith("../")) return false;
  const patternMatches =
    globRegex(pattern).test(collectionRelative) ||
    (pattern.startsWith("**/") && globRegex(pattern.slice(3)).test(collectionRelative));
  if (!patternMatches) return false;
  return !ignore.some((entry) => globRegex(entry).test(collectionRelative) || globRegex(entry).test(notePath));
}
