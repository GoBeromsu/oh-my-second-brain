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
import {
  admitWriteTarget,
  writeResolvedTemplateNote,
  type WriteMode,
} from "../kernel/capture/safe.js";
import type { WriteTargetSource } from "../kernel/conventions/write-protocol.js";
import { backfillDefaults, buildTemplateNoteIndex, deriveTemplateRetrievalAxes, diagnoseTemplates, loadResolvedTemplates, registerExistingTemplate, normalizeTemplateFolderPath, normalizeTemplateSourcePath, regenerateTypes, resumeTemplateTransaction, TEMPLATE_MUTATION_MARKER_PATH } from "../kernel/templates/index.js";
import type { Digest, JsonValue, SourceProposal, TemplateBinding, TemplateSemanticChange } from "../kernel/templates/types.js";
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
import { applyLinksForNote, linkApplyPayload, suggestLinksForNote } from "./link-tools.js";
import { executeTemplateOperation } from "../kernel/templates/operations.js";
import { planTemplateMigration } from "../kernel/templates/migration.js";
import type { McpEngineAdapter } from "../kernel/engine/mcp/facade.js";
import type { Reranker } from "../kernel/engine/retrieval/reranker.js";
import { EngineSearchBackend, requiresEmbeddings } from "../kernel/searchbackend/engine-search-backend.js";
import {
  buildServerInstructions,
  cachedUpdateNotice,
  scheduleUpdateNoticeRefresh,
} from "./update-notice.js";

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

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonRecord(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function stringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" ? value : undefined;
}

function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function runtimeHistory(vault: string): { readonly history?: ReturnType<typeof summarizeRuntimeHistory>; readonly runtimeWarnings?: readonly string[] } {
  try {
    return { history: summarizeRuntimeHistory({ vaultPath: vault }) };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message.replace(/^LEDGER_APPEND_FAILED:\s*/, "") : String(error);
    return { runtimeWarnings: [`LEDGER_APPEND_FAILED: ${detail}. Runtime history is unavailable; verify the external OMS runtime ledger.`] };
  }
}

function recordTemplateList(vault: string, templates: readonly { readonly id: string; readonly inputSignature: string; readonly templateSignature: string }[]): readonly string[] {
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
        inputSignature: template.inputSignature,
        templateSignature: template.templateSignature,
      }), { vaultPath: vault });
    }
    return [];
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message.replace(/^LEDGER_APPEND_FAILED:\s*/, "") : String(error);
    return [`LEDGER_APPEND_FAILED: ${detail}. Template listing succeeded, but runtime history is incomplete.`];
  }
}

function guardedTemplateRequest(args: Record<string, unknown> | undefined):
  | { readonly dryRun: true }
  | { readonly approvedDigest: Digest }
  | undefined {
  if (args?.["dryRun"] === true) {
    return args?.["approvedDigest"] === undefined ? { dryRun: true } : undefined;
  }
  const approvedDigest = args?.["approvedDigest"];
  return isDigest(approvedDigest) ? { approvedDigest } : undefined;
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
const jsonValue = { };
const frontmatter = { type: "object", additionalProperties: jsonValue };
const axisScalar = { anyOf: [string, number, boolean] };
const axisValue = { anyOf: [axisScalar, { type: "array", items: axisScalar }] };
const fieldPredicate = { type: "object", additionalProperties: false, properties: { contains: axisValue, containsAll: { type: "array", items: axisScalar }, in: { type: "array", items: axisScalar }, between: { type: "array", items: axisScalar, minItems: 2, maxItems: 2 }, gte: axisScalar, gt: axisScalar, lte: axisScalar, lt: axisScalar, from: axisScalar, to: axisScalar } };
const queryAxes = { type: "object", additionalProperties: false, properties: { template: string, folder: axisValue, field: { type: "object", additionalProperties: { anyOf: [axisValue, fieldPredicate] } }, link: axisValue } };
const expandStrategy = { type: "object", additionalProperties: false, properties: { kind: { ...string, enum: ["expand"] }, profile: { ...string, enum: ["qmd-v2.8.3"] }, maxQueries: { type: "integer", minimum: 1, maximum: 32 } }, required: ["kind", "profile"] } as const;
const searchProperties = { query: string, searches: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false, properties: { type: { ...string, enum: ["lex", "vec", "hyde"] }, query: string }, required: ["type", "query"] } }, strategy: expandStrategy, collection: string, collections: stringArray, mode: { ...string, enum: ["query", "search", "vsearch"] }, limit: { type: "integer", minimum: 0, default: 10 }, candidateLimit: { type: "integer", minimum: 1 }, rerank: { ...boolean, default: false }, minScore: { ...number, default: 0 }, cursor: string, axes: queryAxes, intent: string, lex: string, vec: string, hyde: string, index: string } as const;
const documentProperties = { target: string, targets: stringArray, notePath: string, fromLine: number, lineCount: number, lineLimit: number, maxBytes: number, lineNumbers: boolean, fullPath: boolean, collection: string, collections: stringArray, index: string } as const;
const contextProperties = { template: string, folder: string, property: string, value: string, wikilink: string, query: string, limit: { type: "integer", minimum: 0 }, maxNeighbors: number, useCache: boolean, ...retrieveContextSemanticInputProperties } as const;
const renderer = { ...string, enum: ["obsidian-core", "templater", "none"] };
const templateBinding = { type: "object", additionalProperties: false, properties: { templateId: string, destinationClass: { ...string, enum: ["managed-default", "registered-existing"] }, renderer, sourceFolder: string, sourcePath: string, contract: string, naming: string }, required: ["templateId", "destinationClass", "renderer", "sourceFolder", "sourcePath", "contract", "naming"] };
const source = { type: "object", additionalProperties: false, properties: { path: string, content: string, publication: { ...string, enum: ["write", "verify-existing"] } }, required: ["path", "content", "publication"] };
const templateFolder = { type: "object", additionalProperties: false, properties: { path: string, mode: { ...string, enum: ["auto", "manual"] }, default: { const: true } }, required: ["path", "mode"] };
const operations: Record<string, readonly Operation[]> = {
  write: [
    { op: "note", name: "write-note", properties: { mode: { ...string, enum: ["create", "append", "update"] }, templateId: string, notePath: string, frontmatter, body: string, dryRun: boolean } },
    { op: "template", name: "write-template", properties: { mode: { ...string, enum: ["create", "update", "reclassify", "relocate-folder", "remove", "default", "register-folder", "register-existing"] }, templateId: string, binding: templateBinding, source, moveStrategy: { ...string, enum: ["oms-managed-rename", "register-already-moved"] }, toClass: { ...string, enum: ["managed-default", "registered-existing"] }, templateFolder: string, folder: templateFolder, deleteSource: boolean, dryRun: boolean, approvedDigest: digestSchema }, required: ["mode"] },
  ],
  search: [{ op: "context", name: "oms_retrieve_context", properties: contextProperties }, { op: "template-scan", name: "oms_template_scan" }, { op: "templates", name: "oms_list_templates", properties: { templateId: string } }, { op: "query", name: "oms_semantic_query", properties: searchProperties }, { op: "index-status", name: "oms_index_status", properties: { view: { ...string, enum: ["status", "collections", "contexts"] }, index: string }, required: ["view"] }, { op: "get-document", name: "oms_get_document", properties: documentProperties }],
  link: [{ op: "suggest", name: "oms_link_suggest", properties: { notePath: string, folder: string }, required: ["notePath"] }, { op: "apply", name: "oms_link_apply", properties: { notePath: string, folder: string, baseContentHash: string, candidateIds: stringArray }, required: ["notePath", "baseContentHash", "candidateIds"] }],
  status: [{ name: "oms_graph_status", direct: true }, { op: "graph", name: "oms_graph_status" }],
  doctor: [{ op: "audit", name: "oms_vault_audit", properties: { folder: string } }, { op: "validate", name: "oms_validate_templates" }, { op: "regenerate-types", name: "oms_regenerate_types", properties: { dryRun: boolean, approvedDigest: digestSchema } }, { op: "backfill-defaults", name: "oms_backfill_defaults", properties: { notePath: string, dryRun: boolean, approvedDigest: digestSchema }, required: ["notePath"] }, { op: "build-graph", name: "oms_graph_build" }, { op: "cleanup", name: "oms_semantic_cleanup", properties: { collection: string, index: string } }, { op: "sync-embeddings", name: "oms_sync_embeddings", properties: { mode: { ...string, enum: ["sync", "embed", "repair"] }, collection: string, index: string, chunkStrategy: string, maxDocsPerBatch: number, maxBatchMb: number, repairMode: { ...string, enum: ["rebuild", "drop"] }, dryRun: boolean }, required: ["mode"] }],
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

function operationSchema(tool: string): Tool["inputSchema"] {
  const toolOperations = operations[tool];
  if (!toolOperations) throw new Error(`Missing MCP operation definition for ${tool}.`);
  if (tool === "status") {
    return {
      type: "object",
      oneOf: [
        { additionalProperties: false, properties: {} },
        { additionalProperties: false, properties: { op: { ...string, const: "graph" } }, required: ["op"] },
      ],
    };
  }
  if (toolOperations.length === 1 && toolOperations[0]?.direct) {
    const { properties = {}, required = [] } = toolOperations[0];
    return { type: "object", additionalProperties: false, properties, required: [...required] };
  }

  const branches: SchemaBranch[] = [];
  for (const { op, properties = {}, required = [] } of toolOperations) {
    const base = { op: { ...string, const: op }, ...properties };
    const baseRequired = ["op", ...required];
    if (op === "note") {
      branches.push({
        additionalProperties: false,
        properties: { op: { ...string, const: "note" }, mode: { const: "create" }, templateId: string, frontmatter, body: string, dryRun: boolean },
        required: ["op", "mode", "templateId", "body"],
      });
      branches.push({
        additionalProperties: false,
        properties: { op: { ...string, const: "note" }, mode: { const: "create" }, frontmatter, body: string, dryRun: boolean },
        required: ["op", "mode", "body"],
      });
      branches.push({
        additionalProperties: false,
        properties: { op: { ...string, const: "note" }, mode: { const: "append" }, notePath: string, body: string, dryRun: boolean },
        required: ["op", "mode", "notePath", "body"],
      });
      branches.push({
        additionalProperties: false,
        properties: { op: { ...string, const: "note" }, mode: { const: "update" }, notePath: string, frontmatter, body: string, dryRun: boolean },
        required: ["op", "mode", "notePath"],
        anyOf: [{ required: ["frontmatter"] }, { required: ["body"] }],
      });
      continue;
    }
    if (op === "template") {
      const shared = { op: { ...string, const: op } };
      const modes: readonly { readonly mode: string; readonly properties: Record<string, object>; readonly required: readonly string[] }[] = [
        { mode: "create", properties: { binding: templateBinding, source }, required: ["binding", "source"] },
        { mode: "update", properties: { templateId: string, binding: templateBinding, source, moveStrategy: { ...string, enum: ["oms-managed-rename", "register-already-moved"] } }, required: ["templateId", "binding", "source"] },
        { mode: "reclassify", properties: { templateId: string, toClass: { ...string, enum: ["managed-default", "registered-existing"] } }, required: ["templateId", "toClass"] },
        { mode: "relocate-folder", properties: { templateFolder: string }, required: ["templateFolder"] },
        { mode: "remove", properties: { templateId: string, deleteSource: boolean }, required: ["templateId", "deleteSource"] },
        { mode: "default", properties: { templateId: string }, required: ["templateId"] },
        { mode: "register-folder", properties: { folder: templateFolder }, required: ["folder"] },
        { mode: "register-existing", properties: { templateId: string, sourceFolder: string, sourcePath: string, renderer, filledBy: stringArray, contract: string, naming: string }, required: ["templateId", "sourceFolder", "sourcePath", "renderer", "filledBy", "contract", "naming"] },
      ];
      for (const item of modes) {
        const mutationRequired = ["op", "mode", ...item.required];
        branches.push({
          additionalProperties: false,
          properties: { ...shared, mode: { const: item.mode }, ...item.properties, dryRun: { const: true } },
          required: [...mutationRequired, "dryRun"],
        });
        branches.push({
          additionalProperties: false,
          properties: { ...shared, mode: { const: item.mode }, ...item.properties, dryRun: { const: false }, approvedDigest: digestSchema },
          required: [...mutationRequired, "approvedDigest"],
        });
      }
      branches.push({
        additionalProperties: false,
        properties: {
          op: { ...string, const: "template" },
          transactionId: string,
          approvedDigest: digestSchema,
        },
        required: ["op", "transactionId", "approvedDigest"],
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
  return { type: "object", oneOf: branches };
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
    description: "Write template-resolved vault notes and guarded template changes.",
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
    description: "Suggest or apply wikilinks; `op` selects the operation.",
    inputSchema: operationSchema("link"),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
    return requestEngines.run(owned, async () => {
      try {
        return await (async () => {
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
      try {
        const convention = await loadResolvedTemplates(vault);
        const diagnosis = await diagnoseTemplates({ vault, source });
        return jsonText({
          vault,
          projectionSource: ".oms/types.json",
          sourceOfTruth: ["markdown notes", "actual Obsidian templates", ".obsidian/types.json", ".oms/template-policy.json", ".oms/taxonomy.json"],
          counts: {
            templates: Object.keys(convention.templates).length,
            globalAxes: Object.keys(convention.globalAxes).length,
          },
          inputSignature: convention.inputSignature,
          managedSourcePaths: convention.managedSourcePaths,
          derivedState: diagnosis,
          ...runtimeHistory(vault),
          engineGraph,
          writeTools: source === "cwd" ? "write-disabled-target-unverified" : "write-gated-by-verified-target-and-contract",
          readTools: omsMcpTools.map(tool => tool.name),
        });
      } catch (error) {
        return jsonText({
          vault,
          projectionSource: "vault-invalid",
          sourceOfTruth: ["actual Obsidian templates", ".obsidian/types.json", ".oms/template-policy.json", ".oms/types.json"],
          error: error instanceof Error ? error.message : String(error),
          counts: null,
          derivedState: { status: "invalid", remediation: "run doctor validate, then regenerate-types with an approved digest" },
          ...runtimeHistory(vault),
          engineGraph,
          writeTools: source === "cwd" ? "write-disabled-target-unverified" : "write-disabled-invalid-template-projection",
          readTools: ["status"],
        });
      }
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
      const convention = await loadResolvedTemplates(vault);
      const templateId = stringArg(args, "templateId");
      const templates = templateId === undefined
        ? Object.values(convention.templates)
        : Object.values(convention.templates).filter(template => template.id === templateId);
      const runtimeWarnings = recordTemplateList(vault, templates);
      return jsonText({
        vault,
        inputSignature: convention.inputSignature,
        templates: templates.map(template => ({ templateId: template.id, destinationClass: template.destinationClass, sourcePath: template.sourcePath, targetFolder: template.targetFolder, fields: template.fields, views: template.views, inputSignature: template.inputSignature, templateSignature: template.templateSignature })),
        axes: deriveTemplateRetrievalAxes(convention),
        ...runtimeHistory(vault),
        ...(runtimeWarnings.length === 0 ? {} : { runtimeWarnings }),
      });
    }

    if (name === "oms_template_scan") {
      const proposal = await planTemplateMigration(vault);
      return jsonText({
        templateFolders: proposal.templateFolders,
        candidates: proposal.candidates.map(candidate => ({
          templateId: candidate.templateId,
          sourcePath: candidate.sourcePath,
          renderer: candidate.renderer,
          filledBy: candidate.filledBy,
          bodyExternal: candidate.bodyExternal,
          selected: proposal.bindings.some(binding => binding.templateId === candidate.templateId && binding.sourcePath === candidate.sourcePath),
          samples: candidate.contractFromNotes?.samples ?? 0,
          coverage: candidate.contractFromNotes?.coverage ?? {},
          diagnostics: [...candidate.rendererDiagnostics, ...(candidate.contractFromNotes?.diagnostics ?? [])],
        })),
        diagnostics: proposal.diagnostics,
        unresolved: proposal.unresolved,
        inputDigest: proposal.inputDigest,
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
        const convention = await loadResolvedTemplates(vault);
        const index = await buildTemplateNoteIndex(vault, convention);
        const notes = folder === undefined ? index.notes : index.notes.filter(note => note.path === folder || note.path.startsWith(`${folder}/`));
        const unresolvedNotes = folder === undefined ? index.unresolvedNotes : index.unresolvedNotes.filter(note => note.path === folder || note.path.startsWith(`${folder}/`));
        const violations = unresolvedNotes.map(note => ({ code: "TEMPLATE_NOTE_IDENTITY_UNRESOLVED", path: note.path, reason: note.reason }));
        return jsonText({ vault, projectionSource: ".oms/types.json", folder: folder ?? null, scannedNotes: notes.length, excludedNotes: convention.managedSourcePaths.length, unresolvedNotes, clean: violations.length === 0, violations, inputSignature: convention.inputSignature });
      } catch {
        const diagnosis = await diagnoseTemplates({ vault, source });
        const violations = folder === undefined
          ? diagnosis.diagnostics
          : diagnosis.diagnostics.filter(item => item.code !== "MIGRATION_NOTE_IDENTITY_UNRESOLVED" || item.path === undefined || item.path === folder || item.path.startsWith(`${folder}/`));
        return jsonText({ vault, projectionSource: "vault-invalid", folder: folder ?? null, scannedNotes: 0, excludedNotes: diagnosis.managedSourceExclusions.length, clean: false, violations });
      }
    }

    if (name === "oms_link_suggest") {
      const notePath = stringArg(args, "notePath");
      if (!notePath) {
        return errorText('Missing required string argument "notePath".');
      }
      const convention = await loadResolvedTemplates(vault);
      const suggestion = await suggestLinksForNote(
        { vault, source, convention, notePath },
        { folder: stringArg(args, "folder") },
      );
      return jsonText({ vault, projectionSource: ".oms/types.json", inputSignature: convention.inputSignature, ...suggestion });
    }

    if (name === "oms_link_apply") {
      const notePath = stringArg(args, "notePath");
      if (!notePath) {
        return errorText('Missing required string argument "notePath".');
      }
      const baseContentHash = stringArg(args, "baseContentHash");
      if (!baseContentHash) {
        return errorText('Missing required string argument "baseContentHash".');
      }
      const idsArg = args?.["candidateIds"];
      if (!Array.isArray(idsArg) || idsArg.some((id) => typeof id !== "string")) {
        return errorText('Argument "candidateIds" must be an array of candidate id strings.');
      }
      const admission = await admitWriteTarget({ vault, source });
      if (admission !== undefined) {
        return jsonText({ vault, projectionSource: ".oms/types.json", applied: false, reason: "write-rejected", write: { status: "rejected", rejection: admission } });
      }
      const convention = await loadResolvedTemplates(vault);
      const outcome = await applyLinksForNote(
        { vault, source, convention, notePath },
        { baseContentHash, candidateIds: idsArg.filter((id): id is string => typeof id === "string") },
        { folder: stringArg(args, "folder") },
      );
      return jsonText({ vault, projectionSource: ".oms/types.json", inputSignature: convention.inputSignature, ...linkApplyPayload(outcome) });
    }

    if (name === "write-note") {
      const mode = stringArg(args, "mode");
      if (!isWriteMode(mode)) {
        return errorText('Argument "mode" must be create, append, or update.');
      }
      const admission = await admitWriteTarget({ vault, source });
      if (admission !== undefined) {
        return jsonText({ vault, resolvedVault: vault, resolutionSource: source, status: "rejected", rejection: admission });
      }
      const convention = await loadResolvedTemplates(vault);
      const frontmatter = args?.["frontmatter"];
      if (frontmatter !== undefined && !isJsonRecord(frontmatter)) {
        return errorText('Argument "frontmatter" must contain only JSON values.');
      }
      const result = await writeResolvedTemplateNote({
        target: { vault, source },
        convention,
        mode,
        templateId: mode === "create" ? stringArg(args, "templateId") : undefined,
        notePath: stringArg(args, "notePath"),
        frontmatter: frontmatter === undefined
          ? undefined
          : isJsonRecord(frontmatter)
            ? frontmatter
            : undefined,
        body: stringArg(args, "body"),
        dryRun: args?.["dryRun"] === true,
      });
      return jsonText({
        vault,
        resolvedVault: vault,
        resolutionSource: source,
        ...result,
      });
    }

    if (name === "oms_validate_templates") {
      return jsonText(await diagnoseTemplates({ vault, source }));
    }
    if (name === "oms_regenerate_types") {
      const request = guardedTemplateRequest(args);
      if (request === undefined) return errorText("Template repair requires dryRun:true or an approvedDigest.");
      return jsonText(await regenerateTypes({ target: { vault, source }, request }));
    }
    if (name === "oms_backfill_defaults") {
      const request = guardedTemplateRequest(args);
      if (request === undefined) return errorText("Template repair requires dryRun:true or an approvedDigest.");
      return jsonText(await backfillDefaults({
        target: { vault, source },
        notePath: stringArg(args, "notePath") ?? "",
        request,
      }));
    }

    if (name === "write-template") {
      const admission = await admitWriteTarget({ vault, source });
      if (admission !== undefined) {
        return jsonText({ vault, status: "rejected", rejection: admission });
      }
      const resumeId = stringArg(args, "transactionId");
      const resumeApproval = args?.["approvedDigest"];
      if (resumeId !== undefined) {
        if (!isDigest(resumeApproval) || args?.["dryRun"] === true) {
          return errorText("Template resume requires transactionId and the exact approvedDigest.");
        }
        return jsonText(await resumeTemplateTransaction(vault, resumeId, resumeApproval, TEMPLATE_MUTATION_MARKER_PATH));
      }

      if (stringArg(args, "mode") === "register-existing") {
        const templateId = stringArg(args, "templateId");
        const sourceFolder = stringArg(args, "sourceFolder");
        const sourcePath = stringArg(args, "sourcePath");
        const renderer = stringArg(args, "renderer");
        const filledBy = args?.["filledBy"];
        const contract = stringArg(args, "contract");
        const naming = stringArg(args, "naming");
        const request = guardedTemplateRequest(args);
        if (
          templateId === undefined ||
          sourceFolder === undefined ||
          sourcePath === undefined ||
          (renderer !== "obsidian-core" && renderer !== "templater" && renderer !== "none") ||
          !Array.isArray(filledBy) ||
          filledBy.some(field => typeof field !== "string") ||
          contract === undefined ||
          naming === undefined ||
          request === undefined
        ) return errorText("Template registration requires templateId, sourceFolder, sourcePath, renderer, filledBy, contract, naming, and dryRun:true or an approvedDigest.");
        return jsonText(await registerExistingTemplate(vault, { templateId, sourceFolder, sourcePath, renderer, filledBy, contract, naming }, request));
      }

      const mode = stringArg(args, "mode");
      let change: TemplateSemanticChange;
      if (mode === "reclassify") {
        const templateId = stringArg(args, "templateId");
        const toClass = stringArg(args, "toClass");
        if (templateId === undefined || (toClass !== "managed-default" && toClass !== "registered-existing")) {
          return errorText("Template reclassify requires templateId and destination class.");
        }
        change = { mode, templateId: templateId as TemplateBinding["templateId"], toClass };
      } else if (mode === "relocate-folder") {
        const templateFolder = stringArg(args, "templateFolder");
        if (templateFolder === undefined) return errorText("Template relocate-folder requires templateFolder.");
        change = { mode, templateFolder: normalizeTemplateFolderPath(templateFolder) };
      } else if (mode === "regenerate") {
        change = { mode };
      } else if (mode === "remove") {
        const templateId = stringArg(args, "templateId");
        const deleteSource = args?.["deleteSource"];
        if (templateId === undefined || typeof deleteSource !== "boolean") return errorText("Template remove requires templateId and deleteSource.");
        change = { mode, templateId: templateId as TemplateBinding["templateId"], deleteSource };
      } else if (mode === "default") {
        const templateId = stringArg(args, "templateId");
        if (templateId === undefined) return errorText("Template default requires templateId.");
        change = { mode, templateId: templateId as TemplateBinding["templateId"] };
      } else if (mode === "register-folder") {
        const folder = args?.["folder"];
        if (
          !isRecord(folder) ||
          typeof folder["path"] !== "string" ||
          (folder["mode"] !== "auto" && folder["mode"] !== "manual") ||
          (folder["default"] !== undefined && folder["default"] !== true)
        ) return errorText("Template register-folder requires a valid folder path, mode, and optional default:true.");
        change = {
          mode,
          folder: {
            path: normalizeTemplateFolderPath(folder["path"]),
            mode: folder["mode"],
            ...(folder["default"] === true ? { default: true } : {}),
          },
        };
      } else if (mode === "create" || mode === "update") {
        const binding = args?.["binding"];
        const proposal = args?.["source"];
        if (
          !isRecord(binding) ||
          typeof binding["templateId"] !== "string" ||
          (binding["destinationClass"] !== "managed-default" && binding["destinationClass"] !== "registered-existing") ||
          (binding["renderer"] !== "obsidian-core" && binding["renderer"] !== "templater" && binding["renderer"] !== "none") ||
          typeof binding["sourceFolder"] !== "string" ||
          typeof binding["sourcePath"] !== "string" ||
          typeof binding["contract"] !== "string" ||
          typeof binding["naming"] !== "string" ||
          !isRecord(proposal) ||
          typeof proposal["path"] !== "string" ||
          typeof proposal["content"] !== "string" ||
          (proposal["publication"] !== "write" && proposal["publication"] !== "verify-existing")
        ) {
          return errorText("Template create/update requires a safe binding and source proposal.");
        }
        const sourcePath = normalizeTemplateSourcePath(proposal["path"]);
        const proposedBinding: TemplateBinding = {
          templateId: binding["templateId"] as TemplateBinding["templateId"],
          destinationClass: binding["destinationClass"],
          renderer: binding["renderer"],
          sourceFolder: normalizeTemplateFolderPath(binding["sourceFolder"]),
          sourcePath: normalizeTemplateSourcePath(binding["sourcePath"]),
          contract: binding["contract"],
          naming: binding["naming"],
        };
        const proposedSource: SourceProposal = {
          path: sourcePath,
          bytes: new TextEncoder().encode(proposal["content"]),
          publication: proposal["publication"],
        };
        if (mode === "create") {
          change = { mode, binding: proposedBinding, source: proposedSource };
        } else {
          const templateId = stringArg(args, "templateId");
          if (templateId === undefined) return errorText("Template update requires templateId.");
          const moveStrategy = stringArg(args, "moveStrategy");
          if (
            moveStrategy !== undefined &&
            moveStrategy !== "oms-managed-rename" &&
            moveStrategy !== "register-already-moved"
          ) {
            return errorText("Template update moveStrategy is invalid.");
          }
          change = {
            mode,
            templateId: templateId as TemplateBinding["templateId"],
            binding: proposedBinding,
            source: proposedSource,
            ...(moveStrategy === undefined ? {} : { moveStrategy }),
          };
        }
      } else {
        return errorText("Template mutation mode is invalid.");
      }

      const request = guardedTemplateRequest(args);
      if (request === undefined) return errorText("Template mutation requires dryRun:true or an approvedDigest.");
      return jsonText(await executeTemplateOperation({ vault, source }, change, request));
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
        await Promise.allSettled(owned.map(assembled => assembled.dispose()));
      }
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

function isWriteMode(value: string | undefined): value is WriteMode {
  return value === "create" || value === "append" || value === "update";
}
