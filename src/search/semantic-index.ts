export {
  DEFAULT_SEMANTIC_PATTERN,
  DEFAULT_SEMANTIC_STORAGE,
  JSON_QMD_COMPATIBILITY,
  normalizeCollection,
  normalizeSemanticStorage,
  normalizeVaultPath,
  QMD_COMPATIBILITY,
  semanticDocumentId,
  semanticDocumentUri,
  semanticIndexPath,
  SEMANTIC_JSON_STORAGE,
  SEMANTIC_SQLITE_STORAGE,
  SQLITE_QMD_COMPATIBILITY,
} from "./semantic-index-core.js";
export { buildSemanticIndex } from "./semantic-index-build.js";
export { readSemanticIndex, writeSemanticIndex } from "./semantic-store.js";
export type { SemanticIndexLoadResult } from "./semantic-store.js";
