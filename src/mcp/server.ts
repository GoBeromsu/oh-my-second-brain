import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { WriteTargetSource } from "../kernel/conventions/write-protocol.js";
import { readBundledPackageVersion } from "../kernel/runtime/assets.js";
import { retrieveContextSemanticInputProperties } from "../kernel/semantic/semantic-retrieve.js";
import { semanticQueryOptionsFromArgs } from "../kernel/semantic/semantic-retrieve-args.js";
import {
  assembleEphemeralCoreSemanticEngine,
  assembleCoreSemanticEngineReadOnly,
  assembleCoreSemanticEngine,
  assembleEngineReadOnly,
  assembleGraphOnlyEngine,
  type AssembledEngine,
} from "../kernel/engine/assemble.js";
import {
  assembleFullSemanticEngine,
  embeddingConfigPresent,
} from "../kernel/semantic/semantic-engine.js";
import type { McpEngineAdapter } from "../kernel/engine/mcp/facade.js";
import type { Reranker } from "../kernel/engine/retrieval/reranker.js";
import { EngineSearchBackend, requiresEmbeddings } from "../kernel/searchbackend/engine-search-backend.js";
import {
  buildServerInstructions,
  cachedUpdateNotice,
  scheduleUpdateNoticeRefresh,
} from "./update-notice.js";
import { handleDoctor } from "./tools/doctor.js";
import { handleInterview } from "./tools/interview.js";
import { handleLink } from "./tools/link.js";
import { handleSearch, prepareSearch, searchExactRead } from "./tools/search.js";
import { errorText, isRecord, jsonText, SemanticIndexUnavailableError, stringArg, type ToolContext } from "./tools/shared.js";
import { handleStatus } from "./tools/status.js";
import { writeNote } from "./tools/write.js";

const SERVER_VERSION = readBundledPackageVersion();

const BASE_SERVER_INSTRUCTIONS =
  "Oh My Second Brain exposes write, search, interview, and doctor tools. search is read-only (op link suggests wikilinks); doctor op status reports vault health and op link-check reports broken links; interview lists the vault questions and the seal state and seals nothing. write and doctor repair operations are gated by a verified vault target (a vault inferred from the current directory is refused); write {path, content, template?} is confined to the vault and saved only when the vault contract allows the note.";

type Operation = {
  readonly op?: string;
  readonly name: string;
  readonly properties?: Record<string, object>;
  readonly required?: readonly string[];
  readonly direct?: boolean;
};
const string = { type: "string" };
const number = { type: "number" };
const boolean = { type: "boolean" };
const stringArray = { type: "array", items: string };
const axisScalar = { anyOf: [string, number, boolean] };
const axisValue = { anyOf: [axisScalar, { type: "array", items: axisScalar }] };
const fieldPredicate = { type: "object", additionalProperties: false, properties: { contains: axisValue, containsAll: { type: "array", items: axisScalar }, in: { type: "array", items: axisScalar }, between: { type: "array", items: axisScalar, minItems: 2, maxItems: 2 }, gte: axisScalar, gt: axisScalar, lte: axisScalar, lt: axisScalar, from: axisScalar, to: axisScalar } };
const queryAxes = { type: "object", additionalProperties: false, properties: { template: string, folder: axisValue, field: { type: "object", additionalProperties: { anyOf: [axisValue, fieldPredicate] } }, link: axisValue } };
const expandStrategy = { type: "object", additionalProperties: false, properties: { kind: { ...string, enum: ["expand"] }, profile: { ...string, enum: ["qmd-v2.8.3"] }, maxQueries: { type: "integer", minimum: 1, maximum: 32 } }, required: ["kind", "profile"] } as const;
const searchProperties = { query: string, searches: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false, properties: { type: { ...string, enum: ["lex", "vec", "hyde"] }, query: string }, required: ["type", "query"] } }, strategy: expandStrategy, collection: string, collections: stringArray, mode: { ...string, enum: ["query", "search", "vsearch"] }, limit: { type: "integer", minimum: 0, default: 10 }, candidateLimit: { type: "integer", minimum: 1 }, rerank: { ...boolean, default: false }, minScore: { ...number, default: 0 }, cursor: string, axes: queryAxes, intent: string, lex: string, vec: string, hyde: string, index: string } as const;
const documentProperties = { target: string, targets: stringArray, notePath: string, fromLine: number, lineCount: number, lineLimit: number, maxBytes: number, lineNumbers: boolean, fullPath: boolean, collection: string, collections: stringArray, index: string } as const;
const contextProperties = { template: string, folder: string, property: string, value: string, wikilink: string, query: string, limit: { type: "integer", minimum: 0 }, maxNeighbors: number, useCache: boolean, ...retrieveContextSemanticInputProperties } as const;
const operations: Record<string, readonly Operation[]> = {
  write: [{ name: "oms_write_note", direct: true, properties: { path: string, content: string, template: string }, required: ["path", "content"] }],
  search: [{ op: "context", name: "oms_retrieve_context", properties: contextProperties }, { op: "templates", name: "oms_list_templates" }, { op: "query", name: "oms_semantic_query", properties: searchProperties }, { op: "index-status", name: "oms_index_status", properties: { view: { ...string, enum: ["status", "collections", "contexts"] }, index: string }, required: ["view"] }, { op: "get-document", name: "oms_get_document", properties: documentProperties }, { op: "link", name: "oms_link_suggest", properties: { notePath: string, folder: string }, required: ["notePath"] }],
  interview: [{ name: "oms_interview", direct: true, properties: { reask: boolean } }],
  doctor: [{ op: "status", name: "oms_graph_status" }, { op: "link-check", name: "oms_link_check", properties: { notePath: string, folder: string }, required: ["notePath"] }, { op: "audit", name: "oms_vault_audit", properties: { folder: string } }, { op: "validate", name: "oms_validate_templates" }, { op: "build-graph", name: "oms_graph_build" }, { op: "cleanup", name: "oms_semantic_cleanup", properties: { collection: string, index: string } }, { op: "sync-embeddings", name: "oms_sync_embeddings", properties: { mode: { ...string, enum: ["sync", "embed", "repair"] }, collection: string, index: string, chunkStrategy: string, maxDocsPerBatch: number, maxBatchMb: number, repairMode: { ...string, enum: ["rebuild", "drop"] }, dryRun: boolean }, required: ["mode"] }],
};
export const demotedOperationNames = [...new Set(Object.values(operations)
  .flatMap((toolOperations) => toolOperations.map((operation) => operation.name)))]
  .sort((left, right) => left.localeCompare(right));
interface SchemaBranch {
  readonly additionalProperties: false;
  readonly properties: Record<string, object>;
  readonly required: readonly string[];
  readonly anyOf?: readonly { readonly required: readonly string[] }[];
}

function schemaEqual(left: object, right: object): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Clients such as Hermes tool_describe read only the top-level properties
// object and ignore oneOf. Project every field that a branch actually accepts
// so the model can see query/limit/axes and guide/check without parsing oneOf.
// Branch schemas stay authoritative: additionalProperties:false and required
// constraints are not copied up, and fields whose branch schemas differ keep
// every alternative instead of collapsing to one enum or const.
function projectBranchProperties(
  branches: readonly SchemaBranch[],
  opOptional: boolean,
): { readonly properties: Record<string, object>; readonly required: readonly string[] } {
  const byField = new Map<string, object[]>();
  const opValues: string[] = [];
  for (const branch of branches) {
    const op = branch.properties["op"] as { readonly const?: unknown } | undefined;
    if (typeof op?.const === "string" && !opValues.includes(op.const)) opValues.push(op.const);
    for (const [field, schema] of Object.entries(branch.properties)) {
      if (field === "op") continue;
      const schemas = byField.get(field) ?? [];
      if (!schemas.some((existing) => schemaEqual(existing, schema))) schemas.push(schema);
      byField.set(field, schemas);
    }
  }
  const properties: Record<string, object> = {};
  if (opValues.length > 0) {
    properties["op"] = opOptional
      ? { type: "string", enum: opValues }
      : { ...string, enum: opValues };
  }
  for (const field of [...byField.keys()].sort((left, right) => left.localeCompare(right))) {
    const schemas = byField.get(field) ?? [];
    const only = schemas[0];
    properties[field] = schemas.length === 1 && only !== undefined ? only : { anyOf: schemas };
  }
  return { properties, required: opOptional || opValues.length === 0 ? [] : ["op"] };
}

function withBranchProjection(
  branches: readonly SchemaBranch[],
  opOptional: boolean,
): Tool["inputSchema"] {
  const { properties, required } = projectBranchProperties(branches, opOptional);
  return { type: "object", properties, required: [...required], oneOf: branches };
}

function operationSchema(tool: string): Tool["inputSchema"] {
  const toolOperations = operations[tool];
  if (!toolOperations) throw new Error(`Missing MCP operation definition for ${tool}.`);
  if (toolOperations.length === 1 && toolOperations[0]?.direct) {
    const { properties = {}, required = [] } = toolOperations[0];
    return { type: "object", additionalProperties: false, properties, required: [...required] };
  }

  const branches: SchemaBranch[] = [];
  for (const { op, properties = {}, required = [] } of toolOperations) {
    const base = { op: { ...string, const: op }, ...properties };
    const baseRequired = ["op", ...required];
    if (op === "templates" || op === "status") {
      branches.push({ additionalProperties: false, properties: { op: { ...string, const: op } }, required: ["op"] });
      continue;
    }
    if (op === "query") {
      const queryProperties: Record<string, object> = { ...properties, op: { ...string, const: op } };
      const { searches: _explicitSearches, lex: _explicitLex, vec: _explicitVec, hyde: _explicitHyde, ...explicitModeProperties } = queryProperties;
      const { mode: _implicitMode, searches: _implicitSearches, ...implicitQueryProperties } = queryProperties;
      const { mode: _typedMode, query: _typedQuery, ...implicitTypedProperties } = queryProperties;
      branches.push({ additionalProperties: false, properties: explicitModeProperties, required: ["op", "mode", "query"] });
      branches.push({ additionalProperties: false, properties: implicitQueryProperties, required: ["op", "query"] });
      branches.push({
        additionalProperties: false,
        properties: implicitTypedProperties,
        required: ["op"],
        anyOf: [{ required: ["searches"] }, { required: ["vec"] }, { required: ["hyde"] }],
      });
      continue;
    }
    if (op === "get-document") {
      const common = { ...properties, op: { ...string, const: op } };
      branches.push({ additionalProperties: false, properties: common, required: ["op", "target"] });
      branches.push({ additionalProperties: false, properties: common, required: ["op", "targets"] });
      branches.push({ additionalProperties: false, properties: common, required: ["op", "notePath", "fromLine", "lineCount"] });
      continue;
    }
    if (op === "sync-embeddings") {
      const common = { op: { ...string, const: op } };
      const syncProperties = { ...common, mode: { const: "sync" }, collection: string, index: string, chunkStrategy: string, maxDocsPerBatch: number, maxBatchMb: number };
      const embedProperties = { ...common, mode: { const: "embed" }, collection: string, index: string, chunkStrategy: string, maxDocsPerBatch: number, maxBatchMb: number };
      const repairProperties = { ...common, mode: { const: "repair" }, repairMode: { ...string, enum: ["rebuild", "drop"] }, dryRun: boolean };
      branches.push({ additionalProperties: false, properties: syncProperties, required: ["op", "mode"] });
      branches.push({ additionalProperties: false, properties: embedProperties, required: ["op", "mode"] });
      branches.push({ additionalProperties: false, properties: repairProperties, required: ["op", "mode", "repairMode"] });
      continue;
    }
    branches.push({ additionalProperties: false, properties: base, required: baseRequired });
  }
  if (tool === "search") {
    // Engine-free exact read: `{path}` with no `op`, never combined with other fields.
    branches.push({ additionalProperties: false, properties: { path: string }, required: ["path"] });
    return withBranchProjection(branches, true);
  }
  return withBranchProjection(branches, false);
}

function resolveOperation(tool: string, op: string | undefined): string | undefined {
  return operations[tool]?.find(
    (operation) => (operation.direct && op === undefined) || operation.op === op,
  )?.name;
}

function unknownOperationMessage(tool: string, op: string | undefined): string {
  const supported = (operations[tool] ?? [])
    .map((operation) => operation.op)
    .filter((operation): operation is string => operation !== undefined)
    .sort();
  return `Unknown operation "${op ?? "(missing)"}" for ${tool}. Supported operations: ${supported.join(", ") || "(none)"}.`;
}

export const omsMcpTools: Tool[] = [
  {
    name: "write",
    title: "Oh My Second Brain write",
    description: "Write one note: {path, content, template?}. The vault contract judges the note before it is saved; a denied write leaves the file unchanged and returns only {field, kind} violations.",
    inputSchema: operationSchema("write"),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "search",
    title: "Oh My Second Brain search",
    description: "Retrieve vault context, template metadata, semantic search, selected documents, and wikilink suggestions (`op: link`). `op` selects the operation. `{path}` alone reads one note by its vault-relative path, normalization-insensitively, without the index or a model.",
    inputSchema: operationSchema("search"),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "interview",
    title: "Oh My Second Brain interview",
    description: "List the vault interview questions the owner would be asked now, with the contract seal state. Seals nothing: answers go through `oms setup --answers`, and only the owner loosens a seal, with `oms interview` in a terminal.",
    inputSchema: operationSchema("interview"),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "doctor",
    title: "Oh My Second Brain doctor",
    description: "Diagnose or repair the vault; `op` selects the operation. `op: status` is read-only vault health and `op: link-check` reports broken wikilinks.",
    inputSchema: operationSchema("doctor"),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

/** The tools annotated read-only; `doctor op: status` reports this list. */
export function readTools(): string[] {
  return omsMcpTools.filter(tool => tool.annotations?.readOnlyHint === true).map(tool => tool.name);
}

export interface OMSMcpServerOptions {
  vault: string;
  /**
   * Real cross-encoder used only for requests that explicitly set
   * `rerank: true`. Without one, those requests fail rather than silently
   * returning the unranked result.
   */
  reranker?: Reranker;
  /**
   * How the vault was resolved. The write surface trusts every source except
   * `cwd` (the server may have booted in an arbitrary directory - issue #58).
   */
  source: WriteTargetSource;
}

export function createOMSMcpServer(opts: OMSMcpServerOptions): Server {
  const vault = path.resolve(opts.vault);
  const source = opts.source;

  // Native engine — graph layer (boot): assembled model-free via deferred
  // (throw-on-use) embedding primitives. Axis-first retrieval and the derived
  // graph cache status scan the vault off the filesystem and need no model.
  // No model load, no SQLite store, no watcher: side-effect-free per boot (R2).
  const engine = assembleGraphOnlyEngine({ vault });

  // SQLite-backed engines are request-scoped: a later request must observe an
  // externally replaced store, and repair must not leave an open handle aimed
  // at a renamed backup. Async-local ownership keeps concurrent requests apart.
  const requestEngines = new AsyncLocalStorage<AssembledEngine[]>();
  const own = <T extends AssembledEngine | null>(assembled: T): T => {
    if (assembled !== null) requestEngines.getStore()?.push(assembled);
    return assembled;
  };
  const getSemanticEngine = (): AssembledEngine =>
    own(assembleFullSemanticEngine(vault, opts.reranker));

  // Core semantic engine (lazy): lex + file-based document reads with NO model.
  // vec/HyDE fail fast (the core store has no vec0 table). This is the model-less
  // backend for the document/retrieve_context paths after the src/search teardown.
  const getCoreSemanticEngine = (): AssembledEngine =>
    own(assembleCoreSemanticEngine({ vault, reranker: opts.reranker }));

  const getReadOnlySemanticEngine = (): AssembledEngine | null =>
    own(assembleEngineReadOnly({
        vault,
        embeddingProvider: process.env["OMS_EMBEDDING_PROVIDER"],
        embeddingModel: process.env["OMS_EMBEDDING_MODEL"],
        reranker: opts.reranker,
      }));
  const getReadOnlyCoreSemanticEngine = (): AssembledEngine | null =>
    own(assembleCoreSemanticEngineReadOnly({ vault, reranker: opts.reranker }));
  const getEphemeralCoreSemanticEngine = async (): Promise<AssembledEngine> =>
    own(assembleEphemeralCoreSemanticEngine({ vault, reranker: opts.reranker }));
  let engineMutationTail = Promise.resolve();
  let engineMutationLifecycleFailure: Error | null = null;
  const engineMutation = (request: { readonly params: { readonly name: string; readonly arguments?: unknown } }): boolean => {
    if (request.params.name !== "doctor" || !isRecord(request.params.arguments)) return false;
    const operation = stringArg(request.params.arguments, "op");
    return operation === "sync-embeddings" || operation === "cleanup";
  };
  const acquireEngineMutation = async (): Promise<() => void> => {
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const previous = engineMutationTail;
    engineMutationTail = previous.then(() => current);
    await previous;
    if (engineMutationLifecycleFailure !== null) {
      release();
      throw engineMutationLifecycleFailure;
    }
    return release;
  };

  // A real embedding provider is configured iff the canonical pair is set
  // (ADR-005). The engine's model-OPTIONAL surface (document reads,
  // retrieve_context's semantic leg, ReadResource) keys off this to decide
  // vec-capable vs core engine WITHOUT a no-model assembly throw.
  const hasEmbeddingModel = (): boolean => embeddingConfigPresent(vault);

  // Adapter resolver for the model-OPTIONAL paths: the vec-capable engine when
  // the canonical embedding pair is configured, else the core (lex + file-based
  // document) engine. The counterpart isEngineSemanticOp path assembles eagerly
  // and lets the no-model error surface loudly (ADR-005). Both honor the same
  // invariant: query + document reads resolve on the SAME backend, so a
  // retrieve_context real-path docid always hydrates where it was produced.
  //
  // No catch here: a CONFIGURED-but-broken full engine (bad provider/model,
  // missing auth, store-open failure) must surface its error loudly rather than
  // silently masquerade as a model-less host (ADR-005). The core fallback is
  // strictly for the absent-config case.
  const resolveCreatingDocumentAdapter = (): McpEngineAdapter =>
    hasEmbeddingModel() ? getSemanticEngine().adapter : getCoreSemanticEngine().adapter;
  const resolveReadOnlyDocumentAdapter = (): McpEngineAdapter =>
    hasEmbeddingModel()
      ? getReadOnlySemanticEngine()?.adapter ?? engine.adapter
      : getReadOnlyCoreSemanticEngine()?.adapter ?? engine.adapter;
  const resolveDocumentAdapter = (publicName: string): McpEngineAdapter => {
    if (publicName === "search") return resolveReadOnlyDocumentAdapter();
    return resolveCreatingDocumentAdapter();
  };
  const resolveReadOnlyIndexAdapter = (): McpEngineAdapter => {
    const adapter = hasEmbeddingModel()
      ? getReadOnlySemanticEngine()?.adapter
      : getReadOnlyCoreSemanticEngine()?.adapter;
    if (adapter === undefined || adapter === null) throw new SemanticIndexUnavailableError();
    return adapter;
  };
  const resolveReadOnlyLexicalAdapter = async (): Promise<McpEngineAdapter> => {
    const adapter = hasEmbeddingModel()
      ? getReadOnlySemanticEngine()?.adapter
      : getReadOnlyCoreSemanticEngine()?.adapter;
    return adapter ?? (await getEphemeralCoreSemanticEngine()).adapter;
  };
  const hasExplicitEmbeddingIntent = (args: Record<string, unknown> | undefined): boolean => {
    const queryOptions = semanticQueryOptionsFromArgs(vault, args);
    return requiresEmbeddings({
      mode: queryOptions.mode,
      strategy: queryOptions.strategy,
      vec: queryOptions.vec,
      hyde: queryOptions.hyde,
      searches: queryOptions.searches,
    });
  };
  const searchBackend = new EngineSearchBackend(
    (requiresEmbeddings) => requiresEmbeddings
      ? (() => {
        // Validate ADR-005 configuration before probing the read-only store:
        // vector intent is actionable only after its required provider/model
        // pair is present, regardless of whether an index exists yet.
        if (!hasEmbeddingModel()) return getSemanticEngine().adapter;
        return resolveReadOnlyIndexAdapter();
      })()
      : resolveReadOnlyIndexAdapter(),
    vault,
  );

  const ctx: ToolContext = {
    vault,
    source,
    engine,
    getSemanticEngine,
    getReadOnlySemanticEngine,
    getReadOnlyCoreSemanticEngine,
    hasEmbeddingModel,
    resolveCreatingDocumentAdapter,
    resolveDocumentAdapter,
    resolveReadOnlyIndexAdapter,
    resolveReadOnlyLexicalAdapter,
    hasExplicitEmbeddingIntent,
    searchBackend,
  };

  const server = new Server(
    { name: "oms", version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      // Cache read only: construction must never touch the network. The
      // registry refresh that fills this cache is scheduled from runMcpServer.
      instructions: buildServerInstructions(
        BASE_SERVER_INSTRUCTIONS,
        cachedUpdateNotice({ installedVersion: SERVER_VERSION }),
      ),
    },
  );

  server.onclose = () => {
    void engine.dispose().catch(() => undefined);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: omsMcpTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const owned: AssembledEngine[] = [];
    const mutation = engineMutation(request);
    let releaseMutation: (() => void) | undefined;
    if (mutation) {
      try {
        releaseMutation = await acquireEngineMutation();
      } catch (error: unknown) {
        return errorText(`ENGINE_LIFECYCLE_FAILED: ${error instanceof Error ? error.message : String(error)} Restart the MCP server before another index mutation.`);
      }
    }
    return requestEngines.run(owned, async () => {
      let result!: CallToolResult;
      let disposalFailure: PromiseRejectedResult | undefined;
      try {
        result = await (async () => {
    let args = isRecord(request.params.arguments) ? request.params.arguments : undefined;
    const publicName = request.params.name;
    if (publicName === "write") return await writeNote(vault, source, args ?? {});
    if (publicName === "interview") return await handleInterview(ctx, args);
    if (publicName === "search") {
      const exact = await searchExactRead(vault, args);
      if (exact !== undefined) return exact;
    }
    const op = stringArg(args, "op");
    let name = resolveOperation(publicName, op);
    if (!name) return errorText(unknownOperationMessage(publicName, op));
    if (publicName === "search") {
      const prepared = prepareSearch(name, op, args);
      if ("content" in prepared) return prepared;
      name = prepared.name;
      args = prepared.args;
    }
    if (name === "oms_graph_status") {
      return await handleStatus(ctx, readTools());
    }

    try {
      const handled = name === "oms_link_suggest" || name === "oms_link_check"
        ? await handleLink(ctx, name, args)
        : publicName === "doctor"
          ? await handleDoctor(ctx, name, args)
          : publicName === "search"
            ? await handleSearch(ctx, publicName, name, args)
            : undefined;
      return handled ?? errorText(`Unknown Oh My Second Brain tool: ${publicName}`);
    } catch (error) {
      if (error instanceof SemanticIndexUnavailableError) {
        return jsonText({
          available: false,
          reason: error.message,
        });
      }
      return errorText(`Oh My Second Brain MCP error: ${error instanceof Error ? error.message : String(error)}`);
    }
        })();
      } finally {
        const disposal = await Promise.allSettled(owned.map(async assembled => assembled.dispose()));
        disposalFailure = disposal.find((item): item is PromiseRejectedResult => item.status === "rejected");
        if (disposalFailure !== undefined) {
          engineMutationLifecycleFailure = new Error(`An engine did not close: ${disposalFailure.reason instanceof Error ? disposalFailure.reason.message : String(disposalFailure.reason)}`);
        }
        releaseMutation?.();
      }
      if (engineMutationLifecycleFailure !== null && disposalFailure !== undefined) {
        return errorText(`ENGINE_LIFECYCLE_FAILED: ${engineMutationLifecycleFailure.message} Restart the MCP server before another index mutation.`);
      }
      return result;
    });
  });

  return server;
}

export async function runMcpServer(opts: OMSMcpServerOptions): Promise<void> {
  const server = createOMSMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Detached and unawaited: a slow or offline registry must not delay serving.
  // Returns null while the cache is fresh, so most boots start nothing at all.
  void scheduleUpdateNoticeRefresh({ installedVersion: SERVER_VERSION });
}

