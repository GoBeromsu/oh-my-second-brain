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
import { admitWriteTarget } from "../kernel/capture/safe.js";
import { judgeReadyTarget, resolveWriteTarget } from "../kernel/contract/judge-write.js";
import { auditVault } from "../kernel/contract/audit.js";
import { contractDoctor, contractStatus } from "../kernel/contract/status.js";
import { formatDenyReason, type Violation } from "../kernel/contract/types.js";
import type { WriteTargetSource } from "../kernel/conventions/write-protocol.js";
import { deriveTemplateRetrievalAxes } from "../kernel/engine/retrieval/axes.js";
import { readSearchTemplateSource } from "../kernel/engine/retrieval/template-source.js";
import { readBundledPackageVersion } from "../kernel/runtime/assets.js";
import { appendRuntimeEvent, createRuntimeEvent, createRuntimeInvocation } from "../kernel/runtime/event-journal.js";
import { summarizeRuntimeHistory } from "../kernel/runtime/event-summary.js";
import { retrieveMorningContext } from "../kernel/search/morning.js";
import { repairDoctor } from "../kernel/doctor/service.js";
import { makeEngineMorningBackend } from "./engine-morning-backend.js";
import { atomicWriteNote } from "./note-write.js";
import {
  handleSemanticTool,
  isEngineSemanticOp,
  isEngineDocumentOp,
  isModelOptionalSemanticQueryOp,
  semanticOptionsFromArgs,
  retrieveContextSemanticInputProperties,
} from "../kernel/semantic/semantic-retrieve.js";
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
import { checkLinksForNote, linkCheckPayload, linkSuggestPayload, suggestLinksForNote } from "./link-tools.js";
import type { McpEngineAdapter } from "../kernel/engine/mcp/facade.js";
import type { Reranker } from "../kernel/engine/retrieval/reranker.js";
import { EngineSearchBackend, requiresEmbeddings } from "../kernel/searchbackend/engine-search-backend.js";
import {
  buildServerInstructions,
  cachedUpdateNotice,
  scheduleUpdateNoticeRefresh,
} from "./update-notice.js";

const SERVER_VERSION = readBundledPackageVersion();

const BASE_SERVER_INSTRUCTIONS =
  "Oh My Second Brain exposes write, search, link, status, and doctor tools. write and doctor repair operations are gated by a verified vault target (a vault inferred from the current directory is refused); write {path, content, template?} is confined to the vault and saved only when the vault contract allows the note.";

function jsonText(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorText(message: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: message,
      },
    ],
  };
}

class SemanticIndexUnavailableError extends Error {
  constructor() {
    super("The semantic index has not been built yet. Run `oms index sync` to build it.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}



function stringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" ? value : undefined;
}


function runtimeHistory(vault: string): { readonly history?: ReturnType<typeof summarizeRuntimeHistory>; readonly runtimeWarnings?: readonly string[] } {
  try {
    return { history: summarizeRuntimeHistory({ vaultPath: vault }) };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message.replace(/^LEDGER_APPEND_FAILED:\s*/, "") : String(error);
    return { runtimeWarnings: [`LEDGER_APPEND_FAILED: ${detail}. Runtime history is unavailable; verify the external OMS runtime ledger.`] };
  }
}

function recordTemplateList(vault: string, templates: readonly { readonly id: string; readonly contractDigest: string }[]): readonly string[] {
  const invocation = createRuntimeInvocation({ surface: "mcp", operation: "template-list", packageVersion: readBundledPackageVersion() });
  try {
    appendRuntimeEvent(createRuntimeEvent(invocation, {
      kind: "template-list",
      outcome: "success",
    }), { vaultPath: vault });
    for (const template of templates) {
      appendRuntimeEvent(createRuntimeEvent(invocation, {
        kind: "template-listed",
        outcome: "success",
        templateId: template.id,
        inputSignature: template.contractDigest,
        templateSignature: template.contractDigest,
      }), { vaultPath: vault });
    }
    return [];
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message.replace(/^LEDGER_APPEND_FAILED:\s*/, "") : String(error);
    return [`LEDGER_APPEND_FAILED: ${detail}. Template listing succeeded, but runtime history is incomplete.`];
  }
}

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
  search: [{ op: "context", name: "oms_retrieve_context", properties: contextProperties }, { op: "templates", name: "oms_list_templates" }, { op: "query", name: "oms_semantic_query", properties: searchProperties }, { op: "index-status", name: "oms_index_status", properties: { view: { ...string, enum: ["status", "collections", "contexts"] }, index: string }, required: ["view"] }, { op: "get-document", name: "oms_get_document", properties: documentProperties }],
  link: [{ op: "suggest", name: "oms_link_suggest", properties: { notePath: string, folder: string }, required: ["notePath"] }, { op: "check", name: "oms_link_check", properties: { notePath: string, folder: string }, required: ["notePath"] }],
  status: [{ name: "oms_graph_status", direct: true }, { op: "graph", name: "oms_graph_status" }],
  doctor: [{ op: "audit", name: "oms_vault_audit", properties: { folder: string } }, { op: "validate", name: "oms_validate_templates" }, { op: "build-graph", name: "oms_graph_build" }, { op: "cleanup", name: "oms_semantic_cleanup", properties: { collection: string, index: string } }, { op: "sync-embeddings", name: "oms_sync_embeddings", properties: { mode: { ...string, enum: ["sync", "embed", "repair"] }, collection: string, index: string, chunkStrategy: string, maxDocsPerBatch: number, maxBatchMb: number, repairMode: { ...string, enum: ["rebuild", "drop"] }, dryRun: boolean }, required: ["mode"] }],
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
  if (tool === "status") {
    const branches: SchemaBranch[] = [
      { additionalProperties: false, properties: {}, required: [] },
      { additionalProperties: false, properties: { op: { ...string, const: "graph" } }, required: ["op"] },
    ];
    return withBranchProjection(branches, true);
  }
  if (toolOperations.length === 1 && toolOperations[0]?.direct) {
    const { properties = {}, required = [] } = toolOperations[0];
    return { type: "object", additionalProperties: false, properties, required: [...required] };
  }

  const branches: SchemaBranch[] = [];
  for (const { op, properties = {}, required = [] } of toolOperations) {
    const base = { op: { ...string, const: op }, ...properties };
    const baseRequired = ["op", ...required];
    if (op === "templates") {
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
  return withBranchProjection(branches, false);
}
const WRITE_KEYS: readonly string[] = ["path", "content", "template"];

function writeDenied(violations: readonly Violation[]): CallToolResult {
  const list = violations.map(violation => ({ field: violation.field, kind: violation.kind }));
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, violations: list, reason: formatDenyReason(list) }, null, 2) }] };
}

/**
 * MCP `write`: the judge decides and this handler saves. Legacy and unknown keys are
 * refused rather than ignored; a denied write leaves the target byte-for-byte unchanged.
 */
async function writeNote(vault: string, source: WriteTargetSource, args: Record<string, unknown>): Promise<CallToolResult> {
  const extra = Object.keys(args).filter(key => !WRITE_KEYS.includes(key)).sort();
  if (extra.length > 0) return writeDenied(extra.map(field => ({ field, kind: "unsupported-input" })));
  const missing = ["path", "content"].filter(key => typeof args[key] !== "string" || (key === "path" && args[key] === ""));
  if (missing.length > 0) return writeDenied(missing.map(field => ({ field, kind: "missing" })));
  if (args["template"] !== undefined && typeof args["template"] !== "string") return writeDenied([{ field: "template", kind: "unsupported-input" }]);
  const admission = await admitWriteTarget({ vault, source });
  if (admission !== undefined) return jsonText({ ok: false, status: "rejected", rejection: admission });
  const content = args["content"] as string;
  const template = args["template"] as string | undefined;
  const resolved = await resolveWriteTarget(vault, path.resolve(vault, args["path"] as string));
  if (resolved.state === "denied") return writeDenied(resolved.verdict.violations);
  const verdict = judgeReadyTarget(resolved, content, template);
  if (!verdict.ok) return writeDenied(verdict.violations);
  const written = await atomicWriteNote(resolved.absolutePath, content, resolved.previousContent);
  if (written !== "written") return writeRetry(written);
  return jsonText({ ok: true, path: resolved.path, missingDefaults: verdict.missingDefaults.map(field => ({ field })) });
}

/** The target moved under the judge; nothing was written and the same call can be retried. */
function writeRetry(state: "changed" | "vanished"): CallToolResult {
  const code = state === "changed" ? "WRITE_TARGET_CHANGED" : "WRITE_TARGET_VANISHED";
  const reason = state === "changed"
    ? "The note changed after it was judged; nothing was written. Read it again and retry."
    : "The note was removed after it was judged; nothing was written. Retry the write.";
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, code, retryable: true, reason }, null, 2) }] };
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
    description: "Retrieve vault context, template metadata, semantic search, and selected documents. `op` selects the operation.",
    inputSchema: operationSchema("search"),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "link",
    title: "Oh My Second Brain link",
    description: "Suggest or check wikilinks; `op` selects the operation. Applying an edit is the agent's job.",
    inputSchema: operationSchema("link"),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "status",
    title: "Oh My Second Brain status",
    description: "Read-only health and statistics for the active vault.",
    inputSchema: operationSchema("status"),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "doctor",
    title: "Oh My Second Brain doctor",
    description: "Diagnose or repair the vault; `op` selects the operation.",
    inputSchema: operationSchema("doctor"),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

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
    const op = stringArg(args, "op");
    let name = resolveOperation(publicName, op);
    if (!name) return errorText(unknownOperationMessage(publicName, op));
    if (publicName === "search" && op === "query") {
      const searches = args?.["searches"];
      if (typeof args?.["query"] === "string" && Array.isArray(searches)) {
        return errorText('Provide exactly one of "query" or "searches" for query.');
      }
    }
    if (name === "oms_index_status") {
      const view = stringArg(args, "view");
      name = view === "status"
        ? "oms_semantic_status"
        : view === "collections"
          ? "oms_semantic_collections"
          : "oms_semantic_contexts";
    }
    if (name === "oms_get_document" && Array.isArray(args?.["targets"])) {
      name = "oms_multi_get_documents";
    } else if (name === "oms_get_document" && typeof args?.["notePath"] === "string") {
      args = {
        ...args,
        target: `${args["notePath"]}:${args["fromLine"]}:${args["lineCount"]}`,
      };
      delete args["notePath"];
      delete args["fromLine"];
      delete args["lineCount"];
    }
    if (name === "oms_graph_status" && publicName === "status" && op === "graph") {
      return jsonText(await engine.adapter.graphStatus(vault));
    }
    if (name === "oms_graph_status") {
      const engineGraph = await engine.adapter.graphStatus(vault).catch(() => null);
      // Posture follows the sealed contract the write surface judges against.
      // An open vault (no contract sealed) stays writable; only an unreadable
      // seal disables writes.
      const meta = await readSearchTemplateSource(vault);
      const contract = await contractStatus(vault);
      return jsonText({
        vault,
        contract,
        counts: meta.source.templates === null
          ? null
          : { templates: Object.keys(meta.source.templates).length },
        generationDigest: meta.digest,
        diagnostics: meta.diagnostics,
        ...runtimeHistory(vault),
        engineGraph,
        writeTools: source === "cwd"
          ? "write-disabled-target-unverified"
          : contract.contract === "unreadable" ? "write-disabled-contract-unreadable" : "write-gated-by-verified-target-and-contract",
        readTools: omsMcpTools.filter(tool => tool.annotations?.readOnlyHint === true).map(tool => tool.name),
      });
    }

    try {
    if (name === "oms_graph_build" || name === "oms_semantic_cleanup" || name === "oms_sync_embeddings") {
      const mode = name === "oms_sync_embeddings" ? stringArg(args, "mode") : undefined;
      if (name === "oms_sync_embeddings" && mode === "repair") {
        const repair = await repairDoctor({
          operation: "repair-index",
          vault,
          source,
          args: { repairMode: args?.["repairMode"], ...(args?.["dryRun"] === undefined ? {} : { dryRun: args["dryRun"] }) },
        });
        return repair.kind === "error" ? errorText(repair.message) : jsonText(repair.value);
      }
      const operation = name === "oms_graph_build" ? "build-graph" : name === "oms_semantic_cleanup" ? "semantic-cleanup" : "sync-embeddings";
      if (name === "oms_sync_embeddings") {
        args = {
          ...args,
          ...(mode === "sync" ? { update: true, embed: false } : { update: true, embed: true }),
        };
        delete args["mode"];
      }
      // A FACTORY, not a value. JavaScript evaluates an argument expression
      // before entering the callee, so passing a constructed adapter here would
      // open - and therefore create - `<vault>/.oms/engine-store.sqlite` before
      // repairDoctor got the chance to run admission. On an invalid global
      // target that means mutating a directory we are about to reject, which
      // breaks the verified-target contract's requirement that admission
      // precede ANY disk mutation. The kernel calls this only after admitting.
      //
      // Deliberately NOT re-checking admission here: two policy paths is how
      // the check drifts. One authoritative decision, deferred dependency.
      const resolveRepairAdapter = (): McpEngineAdapter =>
        operation === "build-graph"
          ? engine.adapter
          : operation === "semantic-cleanup" || (operation === "sync-embeddings" && args?.["embed"] === false)
              ? resolveCreatingDocumentAdapter()
              : getSemanticEngine().adapter;

      const repair = await repairDoctor({
        operation,
        vault,
        source,
        args,
        resolveAdapter: resolveRepairAdapter,
      });
      return repair.kind === "error" ? errorText(repair.message) : jsonText(repair.value);
    }

    if (name === "oms_list_templates") {
      // The declared V5 contract is the authority; approved Markdown does not exist.
      const meta = await readSearchTemplateSource(vault);
      const axes = deriveTemplateRetrievalAxes(meta.source);
      if (meta.source.templates === null && meta.source.defaultFields === null) {
        return jsonText({ vault, generationDigest: meta.digest, state: "unavailable", diagnostics: meta.diagnostics, ...runtimeHistory(vault) });
      }
      const listed = axes.templates;
      const runtimeWarnings = recordTemplateList(
        vault,
        listed.map(entry => ({ id: entry.templateId, contractDigest: meta.digest })),
      );
      return jsonText({
        vault,
        generationDigest: meta.digest,
        // The always-on common contract is reported beside the registrations,
        // because an unbound note is checked against it alone.
        default: { fields: axes.defaultAxes },
        templates: listed.map(entry => ({
          templateId: entry.templateId,
          fields: entry.axes.filter(axis => axis.kind === "field"),
          rulesAvailable: meta.source.templates?.[entry.templateId] !== null,
        })),
        axes,
        diagnostics: meta.diagnostics,
        ...runtimeHistory(vault),
        ...(runtimeWarnings.length === 0 ? {} : { runtimeWarnings }),
      });
    }

    if (name === "oms_retrieve_context") {
      // Graph + semantic fusion. The graph leg stays on the src/graph warm cache;
      // the semantic leg routes to the native engine: vec-capable when a model is
      // configured (parity ranking, real-path docids) and core (lex; vec/HyDE fail
      // fast) otherwise. get/multi_get and ReadResource make the SAME choice, so a
      // docid emitted here always hydrates on the backend that produced it.
      const semantic = semanticOptionsFromArgs(args);
      let contextAdapter = engine.adapter;
      if (semantic?.enabled !== false) {
        try {
          contextAdapter = resolveDocumentAdapter(publicName);
        } catch (error) {
          if (!(error instanceof SemanticIndexUnavailableError)) throw error;
        }
      }
      const semanticBackend = makeEngineMorningBackend(
        contextAdapter,
        vault,
      );
      const limitValue = args?.["limit"];
      const maxNeighborsValue = args?.["maxNeighbors"];
      const useCacheValue = args?.["useCache"];
      const result = await retrieveMorningContext(
        {
          vault,
          template: stringArg(args, "template"),
          folder: stringArg(args, "folder"),
          property: stringArg(args, "property"),
          value: stringArg(args, "value"),
          wikilink: stringArg(args, "wikilink"),
          query: stringArg(args, "query"),
          limit: typeof limitValue === "number" ? limitValue : undefined,
          maxNeighbors: typeof maxNeighborsValue === "number" ? maxNeighborsValue : undefined,
          useCache: typeof useCacheValue === "boolean" ? useCacheValue : undefined,
          semantic,
        },
        semanticBackend,
      );
      return jsonText({
        vault,
        projectionSource: "folders.json",
        ...result,
      });
    }

    // Semantic / sync / cleanup / document ops route to the native engine adapter:
    //   - vec/HyDE semantic ops → EAGER getSemanticEngine().adapter (vec-capable):
    //     a model-less host throws a loud ADR-005 error (surfaces via the dispatch
    //     catch below).
    //   - lex-only query and document ops → resolveDocumentAdapter(): vec-capable
    //     engine when a model is configured, else the core engine. Lex is a real
    //     model-free BM25/FTS feature, not an ADR-005 fake vector fallback.
    // Every other tool never touches the engine here.
    if (isEngineSemanticOp(name) || isEngineDocumentOp(name)) {
      if (name === "oms_semantic_query") {
        const hasQueryAxes =
          isRecord(args?.["axes"]) ||
          args?.["folder"] !== undefined ||
          args?.["field"] !== undefined ||
          args?.["link"] !== undefined;
        if (hasQueryAxes) {
          const axisAdapter = hasExplicitEmbeddingIntent(args)
            ? resolveReadOnlyIndexAdapter()
            : await resolveReadOnlyLexicalAdapter();
          const axisOptions = semanticQueryOptionsFromArgs(vault, args);
          const axisResult = await new EngineSearchBackend(axisAdapter, vault).search({
            ...axisOptions,
            query: axisOptions.lex !== undefined ||
              axisOptions.vec !== undefined ||
              axisOptions.hyde !== undefined
              ? undefined
              : axisOptions.query ?? "",
          });
          return jsonText(axisResult);
        }
        const query = stringArg(args, "query");
        const vec = stringArg(args, "vec");
        const hyde = stringArg(args, "hyde");
        const queryOptions = semanticQueryOptionsFromArgs(vault, args);
        const noPersistentReadOnlyIndex = hasEmbeddingModel()
          ? getReadOnlySemanticEngine() === null
          : getReadOnlyCoreSemanticEngine() === null;
        const hasExplicitLexicalIntent =
          query !== undefined ||
          stringArg(args, "lex") !== undefined ||
          (queryOptions.searches ?? []).some((search) => search.type === "lex");
        const isOverviewRequest =
          query === undefined &&
          (queryOptions.searches ?? []).length === 0 &&
          queryOptions.lex === undefined &&
          queryOptions.vec === undefined &&
          queryOptions.hyde === undefined &&
          queryOptions.axes === undefined;
        if (!hasExplicitEmbeddingIntent(args) && noPersistentReadOnlyIndex && (hasExplicitLexicalIntent || isOverviewRequest)) {
          // Reuse the SearchBackend seam for model-free fallback as well. This
          // keeps overview, cursor, axes, and collection aggregation semantics
          // identical to the indexed path; its normalized default is lexical,
          // so no vector intent is fabricated when the model is absent.
          const fallbackBackend = new EngineSearchBackend(
            await resolveReadOnlyLexicalAdapter(),
            vault,
          );
          const result = await fallbackBackend.search({
            ...queryOptions,
            // `lex` is an explicit lexical representation. Do not send it
            // alongside `query`, which would make the two equivalent forms
            // look contradictory to the SearchBackend normalizer.
            query: queryOptions.lex === undefined ? query ?? "" : undefined,
          });
          return jsonText(result);
        }
        const requestOptions = {
          ...queryOptions,
          collections: queryOptions.collections,
        };
        const result = await searchBackend.search({
          ...requestOptions,
          // `query` is the default lexical representation. An explicit vector
          // or HyDE shorthand selects its own representation instead; only
          // `query` plus typed `searches` is contradictory.
          query: vec !== undefined || hyde !== undefined || queryOptions.lex !== undefined
            ? undefined
            : query ?? "",
          searches: queryOptions.searches,
        });
        return jsonText(result);
      }
      // Every `oms_semantic_query` path returned above, so the former ephemeral
      // lexical fallback keyed on that name could not run. Search's model-free
      // lexical path lives in that returning block; do not reintroduce a second
      // copy here.
      const semanticAdapter =
        isEngineSemanticOp(name) &&
        name !== "oms_semantic_cleanup" &&
        !(name === "oms_sync_embeddings" && args?.["embed"] === false) &&
        !isModelOptionalSemanticQueryOp(name, args, vault)
          ? publicName === "search"
            ? resolveReadOnlyIndexAdapter()
            : getSemanticEngine().adapter
          : isEngineDocumentOp(name)
            ? resolveDocumentAdapter(publicName)
            : publicName === "search"
              ? resolveReadOnlyIndexAdapter()
              : resolveDocumentAdapter(publicName);
      const semanticToolResult = await handleSemanticTool(name, args, vault, semanticAdapter);
      if (semanticToolResult) {
        if (!semanticToolResult.ok) return errorText(semanticToolResult.message);
        return jsonText(semanticToolResult.value);
      }
    }

    if (name === "oms_vault_audit") {
      if (
        args !== undefined &&
        Object.prototype.hasOwnProperty.call(args, "folder") &&
        typeof args["folder"] !== "string"
      ) {
        return errorText('Argument "folder" must be a string top-level folder name.');
      }
      const folder = stringArg(args, "folder");
      try {
        return jsonText({ vault, folder: folder ?? null, ...await auditVault(vault, folder === undefined ? {} : { folder }) });
      } catch {
        const doctor = await contractDoctor(vault, "agent");
        return jsonText({ vault, folder: folder ?? null, contract: doctor.contract, scannedNotes: 0, clean: false, violations: [], findings: doctor.findings });
      }
    }

    if (name === "oms_link_suggest") {
      const notePath = stringArg(args, "notePath");
      if (!notePath) {
        return errorText('Missing required string argument "notePath".');
      }
      const suggestion = await suggestLinksForNote(
        { vault, source, notePath },
        { folder: stringArg(args, "folder") },
      );
      return jsonText({ vault, ...linkSuggestPayload(suggestion) });
    }

    if (name === "oms_link_check") {
      const notePath = stringArg(args, "notePath");
      if (!notePath) {
        return errorText('Missing required string argument "notePath".');
      }
      const report = await checkLinksForNote(
        { vault, source, notePath },
        { folder: stringArg(args, "folder") },
      );
      return jsonText({ vault, ...linkCheckPayload(report) });
    }

    if (name === "oms_validate_templates") {
      return jsonText({ vault, ...await contractDoctor(vault, "agent") });
    }
    return errorText(`Unknown Oh My Second Brain tool: ${publicName}`);
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


