import type {
  MorningRetrieveOptions,
  SemanticFusionScope,
  SemanticHydrateMode,
} from "../search/morning.js";
import type {
  SemanticEmbeddingSyncOptions,
  SemanticGetOptions,
  SemanticMultiGetOptions,
  SemanticSearchFormat,
  SemanticSearchMode,
  SemanticTypedSearch,
  SemanticTypedSearchType,
} from "../search/semantic-contract.js";
import type { McpSemanticQueryAxes } from "../engine/mcp/types.js";

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

/**
 * Preserve the closed query-axis object for the engine to validate. Runtime
 * MCP input is untyped; retaining unknown keys here lets the query adapter
 * reject them loudly instead of silently broadening the result set.
 *
 * Internal callers may still provide top-level axis keys; they are folded into
 * the same `axes` object as the canonical nested form.
 */
function queryAxesArg(args: Record<string, unknown> | undefined): McpSemanticQueryAxes | undefined {
  const nested = args?.["axes"];
  if (nested !== undefined && !isRecord(nested)) {
    // Preserve the malformed value so the engine's closed-axis validator can
    // reject it loudly rather than silently broadening the query.
    return nested as McpSemanticQueryAxes;
  }
  if (nested !== undefined) {
    const axes: Record<string, unknown> = { ...(nested as Record<string, unknown>) };
    for (const key of ["folder", "field", "link"]) {
      if (args?.[key] !== undefined) axes[key] = args[key];
    }
    return axes as McpSemanticQueryAxes;
  }
  const axes: Record<string, unknown> = {};
  for (const key of ["folder", "field", "link"]) {
    if (args?.[key] !== undefined) axes[key] = args[key];
  }
  return Object.keys(axes).length > 0 ? axes as McpSemanticQueryAxes : undefined;
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

function semanticSearchesArg(args: Record<string, unknown> | undefined): readonly SemanticTypedSearch[] | undefined {
  const value = args?.["semanticSearches"];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('Argument "semanticSearches" must be an array.');
  }
  const searches: SemanticTypedSearch[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      throw new Error('Each "semanticSearches" item must be an object.');
    }
    const type = semanticTypedSearchType(stringArg(item, "type"));
    const query = stringArg(item, "query");
    if (type === undefined || query === undefined) {
      throw new Error('Each "semanticSearches" item requires a lex, vec, or hyde type and string query.');
    }
    searches.push({ type, query });
  }
  // An explicitly supplied empty array is meaningful: it is the caller's
  // request to use the normal query/mode path, not an excuse to discard the
  // field while rebuilding options.
  return searches;
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
    chunkStrategy: stringArg(args, "semanticChunkStrategy"),
    candidateLimit: numberArg(args, "semanticCandidateLimit"),
    noRerank: booleanArg(args, "semanticNoRerank"),
    hydrate: semanticHydrate(stringArg(args, "semanticHydrate")),
    hydrateTargets: stringArrayArg(args, "semanticHydrateTargets"),
    hydrateLineLimit: numberArg(args, "semanticHydrateLineLimit"),
    hydrateMaxBytes: numberArg(args, "semanticHydrateMaxBytes"),
    hydrateFromLine: numberArg(args, "semanticHydrateFromLine"),
    hydrateLineCount: numberArg(args, "semanticHydrateLineCount"),
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
    chunkStrategy: stringArg(args, "chunkStrategy"),
    maxDocsPerBatch: numberArg(args, "maxDocsPerBatch"),
    maxBatchMb: numberArg(args, "maxBatchMb"),
  };
}

export function semanticQueryOptionsFromArgs(vault: string, args: Record<string, unknown> | undefined) {
  return {
    vault,
    query: stringArg(args, "query"),
    collection: stringArg(args, "collection"),
    collections: stringArrayArg(args, "collections"),
    collectionPath: stringArg(args, "collectionPath"),
    mode: semanticSearchMode(stringArg(args, "mode")),
    searches: (() => {
      const value = args?.["searches"];
      if (value === undefined) return undefined;
      if (!Array.isArray(value)) throw new Error('Argument "searches" must be an array.');
      const searches: SemanticTypedSearch[] = [];
      for (const item of value) {
        if (!isRecord(item)) {
          throw new Error('Each "searches" item must be an object.');
        }
        const type = semanticTypedSearchType(stringArg(item, "type"));
        const query = stringArg(item, "query");
        if (type === undefined || query === undefined) {
          throw new Error('Each "searches" item requires a lex, vec, or hyde type and string query.');
        }
        searches.push({ type, query });
      }
      return searches;
    })(),
    limit: numberArg(args, "limit"),
    minScore: numberArg(args, "minScore"),
    intent: stringArg(args, "intent"),
    lex: stringArg(args, "lex"),
    vec: stringArg(args, "vec"),
    hyde: stringArg(args, "hyde"),
    all: booleanArg(args, "all"),
    format: semanticSearchFormat(stringArg(args, "format")),
    full: booleanArg(args, "full"),
    lineNumbers: booleanArg(args, "lineNumbers"),
    fullPath: booleanArg(args, "fullPath"),
    chunkStrategy: stringArg(args, "chunkStrategy"),
    index: stringArg(args, "index"),
    candidateLimit: numberArg(args, "candidateLimit"),
    rerank: booleanArg(args, "rerank"),
    noRerank: booleanArg(args, "noRerank"),
    cursor: stringArg(args, "cursor"),
    count: booleanArg(args, "count"),
    facets: booleanArg(args, "facets"),
    axes: queryAxesArg(args),
  };
}

export function semanticStatusOptionsFromArgs(vault: string, args: Record<string, unknown> | undefined) {
  return {
    vault,
    index: indexArg(args),
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
      targets: [...targets],
      lineLimit: numberArg(args, "lineLimit"),
      maxBytes: numberArg(args, "maxBytes"),
      lineNumbers: booleanArg(args, "lineNumbers"),
      fullPath: booleanArg(args, "fullPath"),
    },
  };
}
