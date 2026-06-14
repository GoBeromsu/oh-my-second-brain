import { normalizeSemanticStorage, SEMANTIC_JSON_STORAGE, SEMANTIC_SQLITE_STORAGE } from "./semantic-index-core.js";
import { readSemanticIndex as readJsonSemanticIndex, writeSemanticIndex as writeJsonSemanticIndex } from "./semantic-index-io.js";
import type { SemanticIndexLoadResult } from "./semantic-index-io.js";
import { readSqliteSemanticIndex } from "./semantic-sqlite-read.js";
import { writeSqliteSemanticIndex } from "./semantic-sqlite-write.js";
import type { SemanticIndexFile, SemanticStorage } from "./semantic-types.js";

export type { SemanticIndexLoadResult } from "./semantic-index-io.js";

export async function readSemanticIndex(opts: {
  readonly vault?: string;
  readonly index?: string;
  readonly storage?: SemanticStorage;
}): Promise<SemanticIndexLoadResult> {
  const storage = normalizeSemanticStorage(opts.storage);
  if (storage === SEMANTIC_SQLITE_STORAGE) return readSqliteSemanticIndex(opts);
  return readJsonSemanticIndex({ vault: opts.vault, index: opts.index });
}

export async function writeSemanticIndex(
  index: SemanticIndexFile,
  opts: {
    readonly vault?: string;
    readonly index?: string;
    readonly storage?: SemanticStorage;
    readonly embed?: boolean;
    readonly modelPath?: string;
  },
): Promise<string> {
  const storage = normalizeSemanticStorage(opts.storage ?? index.storage);
  if (storage === SEMANTIC_SQLITE_STORAGE) return writeSqliteSemanticIndex(index, opts);
  return writeJsonSemanticIndex({ ...index, storage: SEMANTIC_JSON_STORAGE }, opts);
}
