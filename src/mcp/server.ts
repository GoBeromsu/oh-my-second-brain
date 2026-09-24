import path from "node:path";
import { readFile } from "node:fs/promises";
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
import { acknowledgeContractSource, checkContract, diagnoseContract, publishContract, relinkContractSource, reviewContractSources, selectContract, ContractServiceError } from "../kernel/templates/service.js";
import { readVaultSettings } from "../kernel/templates/vault-settings.js";
import { parseContractPolicyV5 } from "../kernel/templates/contract-v5.js";
import { inspectContractSource } from "../kernel/templates/source-registry.js";
import type { WriteTargetSource } from "../kernel/conventions/write-protocol.js";
import { buildTemplateNoteIndex, deriveTemplateRetrievalAxes } from "../kernel/templates/index.js";
import { readSearchTemplateSource } from "../kernel/engine/retrieval/template-source.js";
import { readBundledPackageVersion } from "../kernel/runtime/assets.js";
import { appendRuntimeEvent, createRuntimeEvent, createRuntimeInvocation } from "../kernel/runtime/event-journal.js";
import { summarizeRuntimeHistory } from "../kernel/runtime/event-summary.js";
import { retrieveMorningContext } from "../kernel/search/morning.js";
import { repairDoctor } from "../kernel/doctor/service.js";
import { makeEngineMorningBackend } from "./engine-morning-backend.js";
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
import {
  attachTemplateNotice,
  readTemplateChangeNotice,
  templateNoticeInstruction,
  type TemplateChangeNotice,
} from "./template-notice.js";

const SERVER_VERSION = readBundledPackageVersion();

export const BASE_SERVER_INSTRUCTIONS =
  "Oh My Second Brain exposes write, search, link, status, and doctor tools. write and doctor repair operations are gated by a verified vault target (a vault inferred from the current directory is refused); write also enforces vault confinement and contract validation.";

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
const digestSchema = { type: "string", pattern: "^sha256:[0-9a-f]{64}$" };
const nullableDigestSchema = { anyOf: [digestSchema, { type: "null" }] };
// Explicit contract proposals. Contract meaning enters OMS only this way; it is
// never derived from a file name or from template syntax.
const proposalsSchema = { type: "array", items: { } };
const jsonValue = { };
const axisScalar = { anyOf: [string, number, boolean] };
const axisValue = { anyOf: [axisScalar, { type: "array", items: axisScalar }] };
const fieldPredicate = { type: "object", additionalProperties: false, properties: { contains: axisValue, containsAll: { type: "array", items: axisScalar }, in: { type: "array", items: axisScalar }, between: { type: "array", items: axisScalar, minItems: 2, maxItems: 2 }, gte: axisScalar, gt: axisScalar, lte: axisScalar, lt: axisScalar, from: axisScalar, to: axisScalar } };
const queryAxes = { type: "object", additionalProperties: false, properties: { template: string, folder: axisValue, field: { type: "object", additionalProperties: { anyOf: [axisValue, fieldPredicate] } }, link: axisValue } };
const expandStrategy = { type: "object", additionalProperties: false, properties: { kind: { ...string, enum: ["expand"] }, profile: { ...string, enum: ["qmd-v2.8.3"] }, maxQueries: { type: "integer", minimum: 1, maximum: 32 } }, required: ["kind", "profile"] } as const;
const searchProperties = { query: string, searches: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false, properties: { type: { ...string, enum: ["lex", "vec", "hyde"] }, query: string }, required: ["type", "query"] } }, strategy: expandStrategy, collection: string, collections: stringArray, mode: { ...string, enum: ["query", "search", "vsearch"] }, limit: { type: "integer", minimum: 0, default: 10 }, candidateLimit: { type: "integer", minimum: 1 }, rerank: { ...boolean, default: false }, minScore: { ...number, default: 0 }, cursor: string, axes: queryAxes, intent: string, lex: string, vec: string, hyde: string, index: string } as const;
const documentProperties = { target: string, targets: stringArray, notePath: string, fromLine: number, lineCount: number, lineLimit: number, maxBytes: number, lineNumbers: boolean, fullPath: boolean, collection: string, collections: stringArray, index: string } as const;
const contextProperties = { template: string, folder: string, property: string, value: string, wikilink: string, query: string, limit: { type: "integer", minimum: 0 }, maxNeighbors: number, useCache: boolean, ...retrieveContextSemanticInputProperties } as const;
const operations: Record<string, readonly Operation[]> = {
  write: [
    { op: "guide", name: "write-guide", properties: { notePath: string, templateId: string, headingBindings: jsonValue }, required: ["notePath"] },
    { op: "check", name: "write-check", properties: { connectionId: string, sessionId: string }, required: ["connectionId", "sessionId"] },
    { op: "template", name: "write-template", properties: { mode: { ...string, enum: ["publish-contract", "review-sources", "acknowledge-source", "relink-source"] }, policy: jsonValue, templateId: string, reviewedDigest: digestSchema, candidatePath: string, transactionId: string, confirmed: boolean }, required: ["mode"] },
  ],
  search: [{ op: "context", name: "oms_retrieve_context", properties: contextProperties }, { op: "template-scan", name: "oms_template_scan" }, { op: "templates", name: "oms_list_templates", properties: { templateId: string } }, { op: "query", name: "oms_semantic_query", properties: searchProperties }, { op: "index-status", name: "oms_index_status", properties: { view: { ...string, enum: ["status", "collections", "contexts"] }, index: string }, required: ["view"] }, { op: "get-document", name: "oms_get_document", properties: documentProperties }],
  link: [{ op: "suggest", name: "oms_link_suggest", properties: { notePath: string, folder: string }, required: ["notePath"] }, { op: "check", name: "oms_link_check", properties: { notePath: string, folder: string }, required: ["notePath"] }],
  status: [{ name: "oms_graph_status", direct: true }, { op: "graph", name: "oms_graph_status" }],
  doctor: [{ op: "audit", name: "oms_vault_audit", properties: { folder: string } }, { op: "validate", name: "oms_validate_templates" }, { op: "regenerate-types", name: "oms_regenerate_types", properties: { dryRun: boolean, approvedDigest: digestSchema } }, { op: "build-graph", name: "oms_graph_build" }, { op: "cleanup", name: "oms_semantic_cleanup", properties: { collection: string, index: string } }, { op: "sync-embeddings", name: "oms_sync_embeddings", properties: { mode: { ...string, enum: ["sync", "embed", "repair"] }, collection: string, index: string, chunkStrategy: string, maxDocsPerBatch: number, maxBatchMb: number, repairMode: { ...string, enum: ["rebuild", "drop"] }, dryRun: boolean }, required: ["mode"] }],
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
    if (op === "template") {
      branches.push({
        additionalProperties: false,
        properties: {
          op: { ...string, const: "template" },
          transactionId: string,
          approvedDigest: digestSchema,
        },
        required: ["op", "transactionId", "approvedDigest"],
      });
      branches.push({
        additionalProperties: false,
        properties: {
          op: { ...string, const: "template" },
          mode: { const: "interview-next" },
          proposals: proposalsSchema,
        },
        required: ["op", "mode"],
      });
      branches.push({
        additionalProperties: false,
        properties: {
          op: { ...string, const: "template" },
          mode: { const: "interview-answer" },
          questionId: digestSchema,
          answer: jsonValue,
          proposals: proposalsSchema,
          censusDigest: digestSchema,
          expectedLedgerDigest: nullableDigestSchema,
        },
        required: ["op", "mode", "questionId", "answer", "censusDigest", "expectedLedgerDigest"],
      });
      branches.push({
        additionalProperties: false,
        properties: {
          op: { ...string, const: "template" },
          mode: { const: "commit-contracts" },
          censusDigest: digestSchema,
          expectedLedgerDigest: nullableDigestSchema,
          proposals: proposalsSchema,
          dryRun: { const: true },
        },
        required: ["op", "mode", "censusDigest", "expectedLedgerDigest", "dryRun"],
      });
      branches.push({
        additionalProperties: false,
        properties: {
          op: { ...string, const: "template" },
          mode: { const: "commit-contracts" },
          censusDigest: digestSchema,
          expectedLedgerDigest: nullableDigestSchema,
          proposals: proposalsSchema,
          dryRun: { const: false },
          approvedDigest: digestSchema,
        },
        required: ["op", "mode", "censusDigest", "expectedLedgerDigest", "approvedDigest"],
      });
      continue;
    }
    if (op === "templates") {
      branches.push({ additionalProperties: false, properties: { op: { ...string, const: op } }, required: ["op"] });
      branches.push({ additionalProperties: false, properties: { op: { ...string, const: op }, templateId: string }, required: ["op", "templateId"] });
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
    if (op === "regenerate-types" || op === "backfill-defaults") {
      const unguarded: Record<string, object> = {};
      for (const [key, value] of Object.entries(base)) {
        if (key !== "dryRun" && key !== "approvedDigest") unguarded[key] = value;
      }
      branches.push({ additionalProperties: false, properties: { ...unguarded, dryRun: { const: true } }, required: [...baseRequired, "dryRun"] });
      branches.push({ additionalProperties: false, properties: { ...unguarded, dryRun: { const: false }, approvedDigest: digestSchema }, required: [...baseRequired, "approvedDigest"] });
      continue;
    }
    branches.push({ additionalProperties: false, properties: base, required: baseRequired });
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
    description: "Guide a note before the agent writes it, check the saved file, complete it with a separate review, and publish approved contract changes.",
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
  /**
   * Read-only template census captured before boot. The synchronous factory
   * receives this optional value so runMcpServer can include a boot line
   * without making construction itself asynchronous.
   */
  templateNotice?: TemplateChangeNotice | null;
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
  // (ADR-007). The engine's model-OPTIONAL surface (document reads,
  // retrieve_context's semantic leg, ReadResource) keys off this to decide
  // vec-capable vs core engine WITHOUT a no-model assembly throw.
  const hasEmbeddingModel = (): boolean => embeddingConfigPresent(vault);

  // Adapter resolver for the model-OPTIONAL paths: the vec-capable engine when
  // the canonical embedding pair is configured, else the core (lex + file-based
  // document) engine. The counterpart isEngineSemanticOp path assembles eagerly
  // and lets the no-model error surface loudly (ADR-007). Both honor the same
  // invariant: query + document reads resolve on the SAME backend, so a
  // retrieve_context real-path docid always hydrates where it was produced.
  //
  // No catch here: a CONFIGURED-but-broken full engine (bad provider/model,
  // missing auth, store-open failure) must surface its error loudly rather than
  // silently masquerade as a model-less host (ADR-007). The core fallback is
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
        // Validate ADR-007 configuration before probing the read-only store:
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
        templateNoticeInstruction(opts.templateNotice),
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
      // Posture follows the explicit contract the write surface actually uses:
      // the declared V5 policy plus the portable settings that carry identity.
      const meta = await readSearchTemplateSource(vault);
      const declared = meta.source.templates !== null || meta.source.defaultFields !== null;
      const settings = declared ? await readVaultSettings(vault).catch(() => null) : null;
      const writable = declared && settings !== null;
      return jsonText({
        vault,
        projectionSource: declared ? ".oms/template-policy.json" : "vault-invalid",
        sourceOfTruth: ["markdown notes", "the user's own template sources", ".oms/template-policy.json", ".oms/taxonomy.json", ".oms/settings.json"],
        counts: declared
          ? {
            templates: Object.keys(meta.source.templates ?? {}).length,
            globalAxes: Object.keys(meta.source.globalAxes ?? {}).length,
          }
          : null,
        generationDigest: meta.digest,
        derivedState: declared
          ? {
            status: writable ? "approved" : "setup-required",
            ...(writable ? {} : { remediation: "run oms setup to publish portable vault settings" }),
            diagnostics: meta.diagnostics,
          }
          : { status: "invalid", remediation: "restore or publish .oms/template-policy.json, then retry", diagnostics: meta.diagnostics },
        ...runtimeHistory(vault),
        engineGraph,
        writeTools: source === "cwd"
          ? "write-disabled-target-unverified"
          : writable ? "write-gated-by-verified-target-and-contract" : "write-disabled-invalid-template-projection",
        readTools: declared ? omsMcpTools.map(tool => tool.name) : ["status"],
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
      const templateId = stringArg(args, "templateId");
      const listed = axes.templates.filter(entry => templateId === undefined || entry.templateId === templateId);
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

    if (name === "oms_template_scan") {
      // Read-only review evidence for the explicit contract: registration
      // identity, its source path, and drift state. Source bytes are never
      // returned here, and Markdown is never parsed for meaning.
      const meta = await readSearchTemplateSource(vault);
      if (meta.source.templates === null) {
        return jsonText({ vault, generationDigest: meta.digest, state: "unavailable", diagnostics: meta.diagnostics });
      }
      const policy = parseContractPolicyV5(await readFile(path.join(vault, ".oms", "template-policy.json"), "utf8"));
      const registrations = [];
      for (const [id, entry] of Object.entries(policy.templates)) {
        if (entry.status !== "active") {
          registrations.push({ templateId: id, status: entry.status, reasons: entry.reasons });
          continue;
        }
        const review = await inspectContractSource(vault, policy, id);
        registrations.push({
          templateId: id,
          status: "active" as const,
          sourceIdentity: review.sourceIdentity,
          path: review.path,
          approvedDigest: review.approvedDigest,
          currentDigest: review.currentDigest,
          state: review.state,
        });
      }
      return jsonText({
        vault,
        generationDigest: meta.digest,
        revision: policy.revision,
        common: policy.common.status,
        registrations,
        diagnostics: meta.diagnostics,
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
        projectionSource: ".oms/types.json",
        ...result,
      });
    }

    // Semantic / sync / cleanup / document ops route to the native engine adapter:
    //   - vec/HyDE semantic ops → EAGER getSemanticEngine().adapter (vec-capable):
    //     a model-less host throws a loud ADR-007 error (surfaces via the dispatch
    //     catch below).
    //   - lex-only query and document ops → resolveDocumentAdapter(): vec-capable
    //     engine when a model is configured, else the core engine. Lex is a real
    //     model-free BM25/FTS feature, not an ADR-007 fake vector fallback.
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
      const useEphemeralLexicalFallback =
        name === "oms_semantic_query" &&
        publicName === "search" &&
        !hasExplicitEmbeddingIntent(args) &&
        (hasEmbeddingModel()
          ? getReadOnlySemanticEngine() === null
          : getReadOnlyCoreSemanticEngine() === null);
      const semanticAdapter =
        useEphemeralLexicalFallback
          ? await resolveReadOnlyLexicalAdapter()
          :
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
      const semanticToolResult = await handleSemanticTool(
        name,
        useEphemeralLexicalFallback
          ? { ...args, lex: stringArg(args, "query") }
          : args,
        vault,
        semanticAdapter,
      );
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
        const meta = await readSearchTemplateSource(vault);
        if (meta.source.templates === null && meta.source.defaultFields === null) {
          throw new Error(meta.diagnostics.map(item => `${item.code}: ${item.message}`).join("; ") || "the declared contract is unavailable");
        }
        const index = await buildTemplateNoteIndex(vault, meta.source);
        const notes = folder === undefined ? index.notes : index.notes.filter(note => note.path === folder || note.path.startsWith(`${folder}/`));
        const unresolvedNotes = folder === undefined ? index.unresolvedNotes : index.unresolvedNotes.filter(note => note.path === folder || note.path.startsWith(`${folder}/`));
        const violations = unresolvedNotes.map(note => ({ code: "TEMPLATE_NOTE_IDENTITY_UNRESOLVED", path: note.path, reason: note.reason }));
        return jsonText({ vault, projectionSource: ".oms/types.json", folder: folder ?? null, scannedNotes: notes.length, excludedNotes: (meta.source.sourcePaths ?? []).length, unresolvedNotes, clean: violations.length === 0, violations, generationDigest: meta.digest });
      } catch {
        const diagnosis = await diagnoseContract({ target: { vault, source } });
        const violations = folder === undefined
          ? diagnosis.diagnostics
          : diagnosis.diagnostics.filter(item => item.path === undefined || item.path === folder || item.path.startsWith(`${folder}/`));
        return jsonText({ vault, projectionSource: "vault-invalid", folder: folder ?? null, scannedNotes: 0, excludedNotes: 0, clean: false, violations });
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

    if (name === "write-guide") {
      const notePath = stringArg(args, "notePath");
      if (!notePath) return errorText('Missing required string argument "notePath".');
      const bindings = args?.["headingBindings"];
      if (bindings !== undefined && (typeof bindings !== "object" || bindings === null || Array.isArray(bindings))) {
        return errorText('Argument "headingBindings" must be an object of declared slot values.');
      }
      try {
        const selection = await selectContract({
          target: { vault, source },
          notePath,
          templateId: stringArg(args, "templateId") ?? null,
          ...(bindings === undefined ? {} : { headingBindings: bindings as Record<string, string> }),
        });
        return jsonText({ vault, resolvedVault: vault, resolutionSource: source, ...selection });
      } catch (error) {
        if (error instanceof ContractServiceError) return jsonText({ vault, state: "rejected", rejection: { code: error.code, message: error.message } });
        throw error;
      }
    }

    if (name === "write-check") {
      const connectionId = stringArg(args, "connectionId");
      const sessionId = stringArg(args, "sessionId");
      if (!connectionId || !sessionId) return errorText('Missing required string arguments "connectionId" and "sessionId".');
      try {
        const checked = await checkContract({ vault, locator: { connectionId, sessionId } });
        return jsonText({ vault, resolvedVault: vault, resolutionSource: source, ...checked });
      } catch (error) {
        if (error instanceof ContractServiceError) return jsonText({ vault, state: "rejected", rejection: { code: error.code, message: error.message } });
        throw error;
      }
    }

    if (name === "oms_validate_templates") {
      return jsonText(await diagnoseContract({ target: { vault, source } }));
    }
    if (name === "write-template") {
      const admission = await admitWriteTarget({ vault, source });
      if (admission !== undefined) {
        return jsonText({ vault, status: "rejected", rejection: admission });
      }
      const mode = stringArg(args, "mode");
      if (mode === "publish-contract") {
        const transactionId = stringArg(args, "transactionId");
        if (transactionId === undefined) return errorText("Contract publication requires an explicit transactionId.");
        if (args?.["policy"] === undefined) return errorText("Contract publication requires the explicit V5 policy document.");
        return jsonText({ vault, ...await publishContract({ target: { vault, source }, policy: args["policy"], transactionId, confirmed: args["confirmed"] === true }) });
      }
      if (mode === "review-sources") {
        const templateId = stringArg(args, "templateId");
        return jsonText(await reviewContractSources({ target: { vault, source }, ...(templateId === undefined ? {} : { templateId }) }));
      }
      if (mode === "acknowledge-source" || mode === "relink-source") {
        const templateId = stringArg(args, "templateId");
        const transactionId = stringArg(args, "transactionId");
        const confirmed = args?.["confirmed"] === true;
        if (templateId === undefined || transactionId === undefined) {
          return errorText("Source publication requires templateId and an explicit transactionId.");
        }
        if (mode === "acknowledge-source") {
          const reviewedDigest = stringArg(args, "reviewedDigest");
          if (reviewedDigest === undefined) return errorText("Source acknowledgment requires the reviewedDigest observed during review.");
          return jsonText({ vault, ...await acknowledgeContractSource({ target: { vault, source }, templateId, reviewedDigest, transactionId, confirmed }) });
        }
        const candidatePath = stringArg(args, "candidatePath");
        if (candidatePath === undefined) return errorText("Source relocation requires an explicit candidatePath.");
        return jsonText({ vault, ...await relinkContractSource({ target: { vault, source }, templateId, candidatePath, transactionId, confirmed }) });
      }
      return errorText("Template modes are publish-contract, review-sources, acknowledge-source, and relink-source.");
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
        if (
          request.params.name === "write" ||
          request.params.name === "search" ||
          request.params.name === "status"
        ) {
          result = await attachTemplateNotice(
            result,
            vault,
            request.params.name === "status" ? "poll" : "dedupe",
          );
        }
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
  // The review census is read before synchronous server construction so the
  // initial notice can be included in instructions without making the factory
  // itself asynchronous. Tool-result delivery re-reads it for long-lived
  // sessions and therefore also observes edits after this boot.
  const templateNotice = await readTemplateChangeNotice(opts.vault);
  const server = createOMSMcpServer({ ...opts, templateNotice });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Detached and unawaited: a slow or offline registry must not delay serving.
  // Returns null while the cache is fresh, so most boots start nothing at all.
  void scheduleUpdateNoticeRefresh({ installedVersion: SERVER_VERSION });
}


