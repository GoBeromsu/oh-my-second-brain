import type {
  MorningRetrieveOptions,
  SemanticFusionScope,
  SemanticHydrateMode,
} from "../retrieve/morning.js";
import type {
  SemanticEmbeddingSyncOptions,
  SemanticGetOptions,
  SemanticMultiGetOptions,
  SemanticSearchFormat,
  SemanticSearchMode,
  SemanticStorage,
  SemanticTypedSearch,
  SemanticTypedSearchType,
} from "../search/semantic.js";

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberArg(args: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = args?.[key];
  return typeof value === "number" ? value : undefined;
}

function booleanArg(args: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = args?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayArg(args: Record<string, unknown> | undefined, key: string): readonly string[] | undefined {
  const value = args?.[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
}

function semanticSearchMode(value: string | undefined): SemanticSearchMode | undefined {
  return value === "query" || value === "search" || value === "vsearch" ? value : undefined;
}

function semanticSearchFormat(value: string | undefined): SemanticSearchFormat | undefined {
  return value === "json" || value === "files" ? value : undefined;
}

function semanticScope(value: string | undefined): SemanticFusionScope | undefined {
  return value === "global" || value === "graph" ? value : undefined;
}

function semanticHydrate(value: string | undefined): SemanticHydrateMode | undefined {
  return value === "none" || value === "top" || value === "all" || value === "targets" ? value : undefined;
}

function semanticTypedSearchType(value: string | undefined): SemanticTypedSearchType | undefined {
  return value === "lex" || value === "vec" || value === "hyde" ? value : undefined;
}

function semanticStorage(value: string | undefined): SemanticStorage | undefined {
  return value === "qmd-sqlite" || value === "oms-native-json" ? value : undefined;
}

function storageArg(args: Record<string, unknown> | undefined, key: string): SemanticStorage | undefined {
  return semanticStorage(stringArg(args, key)) ?? semanticStorage(stringArg(args, "storage"));
}

function modelPathArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
  return stringArg(args, key) ?? stringArg(args, "modelPath");
}

function semanticSearchesArg(args: Record<string, unknown> | undefined): readonly SemanticTypedSearch[] | undefined {
  const value = args?.["semanticSearches"];
  if (!Array.isArray(value)) return undefined;
  const searches: SemanticTypedSearch[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const type = semanticTypedSearchType(stringArg(item, "type"));
    const query = stringArg(item, "query");
    if (type && query) searches.push({ type, query });
  }
  return searches.length > 0 ? searches : undefined;
}

export function semanticOptionsFromArgs(
  args: Record<string, unknown> | undefined,
): NonNullable<MorningRetrieveOptions["semantic"]> {
  return {
    enabled: booleanArg(args, "semanticEnabled"),
    collection: stringArg(args, "semanticCollection"),
    limit: numberArg(args, "semanticLimit"),
    scope: semanticScope(stringArg(args, "semanticScope")),
    mode: semanticSearchMode(stringArg(args, "semanticMode")),
    intent: stringArg(args, "semanticIntent"),
    searches: semanticSearchesArg(args),
    lex: stringArg(args, "semanticLex"),
    vec: stringArg(args, "semanticVec"),
    hyde: stringArg(args, "semanticHyde"),
    minScore: numberArg(args, "semanticMinScore"),
    all: booleanArg(args, "semanticAll"),
    format: semanticSearchFormat(stringArg(args, "semanticFormat")),
    full: booleanArg(args, "semanticFull"),
    lineNumbers: booleanArg(args, "semanticLineNumbers"),
    fullPath: booleanArg(args, "semanticFullPath"),
    index: stringArg(args, "semanticIndex"),
    storage: storageArg(args, "semanticStorage"),
    modelPath: modelPathArg(args, "semanticModelPath"),
    chunkStrategy: stringArg(args, "semanticChunkStrategy"),
    candidateLimit: numberArg(args, "semanticCandidateLimit"),
    noRerank: booleanArg(args, "semanticNoRerank"),
    hydrate: semanticHydrate(stringArg(args, "semanticHydrate")),
    hydrateTargets: stringArrayArg(args, "semanticHydrateTargets"),
    hydrateLineLimit: numberArg(args, "semanticHydrateLineLimit"),
    hydrateMaxBytes: numberArg(args, "semanticHydrateMaxBytes"),
    hydrateFromLine: numberArg(args, "semanticHydrateFromLine"),
    hydrateLineCount: numberArg(args, "semanticHydrateLineCount"),
    syncBeforeSearch: booleanArg(args, "embeddingSyncBeforeSearch"),
    syncEnsureCollection: booleanArg(args, "embeddingSyncEnsureCollection"),
    syncUpdate: booleanArg(args, "embeddingSyncUpdate"),
    syncEmbed: booleanArg(args, "embeddingSyncEmbed"),
    syncForce: booleanArg(args, "embeddingSyncForce"),
    syncPull: booleanArg(args, "embeddingSyncPull"),
    syncMaxDocsPerBatch: numberArg(args, "embeddingSyncMaxDocsPerBatch"),
    syncMaxBatchMb: numberArg(args, "embeddingSyncMaxBatchMb"),
    syncStorage: storageArg(args, "embeddingSyncStorage"),
    syncModelPath: modelPathArg(args, "embeddingSyncModelPath"),
  };
}

export function embeddingSyncOptionsFromArgs(
  vault: string,
  args: Record<string, unknown> | undefined,
): SemanticEmbeddingSyncOptions {
  return {
    vault,
    collection: stringArg(args, "collection"),
    ensureCollection: booleanArg(args, "ensureCollection"),
    update: booleanArg(args, "update"),
    embed: booleanArg(args, "embed"),
    force: booleanArg(args, "force"),
    pull: booleanArg(args, "pull"),
    index: stringArg(args, "index"),
    storage: storageArg(args, "storage"),
    modelPath: modelPathArg(args, "modelPath"),
    chunkStrategy: stringArg(args, "chunkStrategy"),
    maxDocsPerBatch: numberArg(args, "maxDocsPerBatch"),
    maxBatchMb: numberArg(args, "maxBatchMb"),
  };
}

export function semanticQueryOptionsFromArgs(vault: string, args: Record<string, unknown> | undefined) {
  return {
    vault,
    query: stringArg(args, "query") ?? "",
    collection: stringArg(args, "collection"),
    mode: semanticSearchMode(stringArg(args, "mode")),
    limit: numberArg(args, "limit"),
    minScore: numberArg(args, "minScore"),
    intent: stringArg(args, "intent"),
    lex: stringArg(args, "lex"),
    vec: stringArg(args, "vec"),
    hyde: stringArg(args, "hyde"),
    index: stringArg(args, "index"),
    storage: storageArg(args, "storage"),
    modelPath: modelPathArg(args, "modelPath"),
  };
}

export function semanticStatusOptionsFromArgs(vault: string, args: Record<string, unknown> | undefined) {
  return {
    vault,
    index: indexArg(args),
    storage: storageArg(args, "storage"),
    modelPath: modelPathArg(args, "modelPath"),
  };
}

export function indexArg(args: Record<string, unknown> | undefined): string | undefined {
  return stringArg(args, "index");
}

export function documentGetOptionsFromArgs(args: Record<string, unknown> | undefined): ParseResult<SemanticGetOptions> {
  const target = stringArg(args, "target");
  if (!target) return { ok: false, message: 'Missing required string argument "target".' };
  return {
    ok: true,
    value: {
      target,
      collection: stringArg(args, "collection"),
      fromLine: numberArg(args, "fromLine"),
      lineCount: numberArg(args, "lineCount"),
      lineNumbers: booleanArg(args, "lineNumbers"),
      fullPath: booleanArg(args, "fullPath"),
      index: stringArg(args, "index"),
      storage: storageArg(args, "storage"),
      modelPath: modelPathArg(args, "modelPath"),
    },
  };
}

export function documentMultiGetOptionsFromArgs(
  args: Record<string, unknown> | undefined,
): ParseResult<SemanticMultiGetOptions> {
  const target = stringArg(args, "target");
  const targets = stringArrayArg(args, "targets") ?? (target ? [target] : undefined);
  if (!targets || targets.length === 0) {
    return { ok: false, message: 'Missing "target" string or "targets" string array.' };
  }
  return {
    ok: true,
    value: {
      targets,
      lineLimit: numberArg(args, "lineLimit"),
      maxBytes: numberArg(args, "maxBytes"),
      lineNumbers: booleanArg(args, "lineNumbers"),
      fullPath: booleanArg(args, "fullPath"),
      index: stringArg(args, "index"),
      storage: storageArg(args, "storage"),
      modelPath: modelPathArg(args, "modelPath"),
    },
  };
}
