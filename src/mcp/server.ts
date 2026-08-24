import { readFile } from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { parseNote } from "../kernel/conventions/frontmatter.js";
import { validateFrontmatter } from "../kernel/conventions/validate.js";
import { lintVault } from "../kernel/engine/conventions/vault-lint.js";
import {
  admitWriteTarget,
  safeVaultNotePath,
  writeNote,
  type WriteMode,
} from "../kernel/capture/safe.js";
import {
  graphCacheStatus,
  lazyLoadNoteBody,
} from "../kernel/graph/cache.js";
import type { WriteTargetSource } from "../kernel/conventions/write-protocol.js";
import { readBundledPackageVersion } from "../kernel/runtime/assets.js";
import { resolveActiveOntology } from "../kernel/ontology/active.js";
import { resolveConcept } from "../kernel/ontology/resolver.js";
import { retrieveMorningContext } from "../kernel/search/morning.js";
import { repairDoctor } from "../kernel/doctor/service.js";
import { makeEngineMorningBackend } from "./engine-morning-backend.js";
import type { Concept } from "../kernel/ontology/types.js";
import {
  handleSemanticTool,
  isEngineSemanticOp,
  isEngineDocumentOp,
  isModelOptionalSemanticQueryOp,
  semanticOptionsFromArgs,
  retrieveContextSemanticInputProperties,
} from "../kernel/semantic/semantic-retrieve.js";
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
import type { McpEngineAdapter } from "../kernel/engine/mcp/facade.js";
import type { McpSemanticTypedSearch } from "../kernel/engine/mcp/types.js";
import type { Reranker } from "../kernel/engine/retrieval/reranker.js";
import { EngineSearchBackend, requiresEmbeddings } from "../kernel/searchbackend/engine-search-backend.js";
import {
  buildServerInstructions,
  cachedUpdateNotice,
  scheduleUpdateNoticeRefresh,
} from "./update-notice.js";

const SERVER_VERSION = readBundledPackageVersion();

export const BASE_SERVER_INSTRUCTIONS =
  "Oh My Second Brain exposes write, search, link, status, and doctor tools. oms_write and doctor repair operations are gated by a verified vault target (a vault inferred from the current directory is refused); oms_write also enforces vault confinement and contract validation.";

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
    super("The semantic index has not been built yet. Run `oms semantic sync` to build it.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" ? value : undefined;
}

function conceptSummary(concept: Concept): Record<string, unknown> {
  return {
    concept: concept.concept,
    intent: concept.intent,
    folder: concept.folder,
    fields: concept.fields.map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required,
      intent: field.intent,
    })),
    retrievalViews: (concept.lenses ?? []).map((lens) => ({
      name: lens.name,
      intent: lens.intent,
      fields: lens.fields,
    })),
  };
}

type Operation = {
  readonly op?: string;
  readonly name: string;
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly direct?: boolean;
};
const string = { type: "string" };
const number = { type: "number" };
const boolean = { type: "boolean" };
const stringArray = { type: "array", items: string };
const searchProperties = {
  query: string, searches: { type: "array", maxItems: 10, items: { type: "object", properties: { type: { ...string, enum: ["lex", "vec", "hyde"] }, query: string }, required: ["type", "query"] } },
  collection: string, collections: stringArray, mode: { ...string, enum: ["query", "search", "vsearch"] }, limit: { ...number, default: 10 }, candidateLimit: number, rerank: { ...boolean, default: false }, minScore: { ...number, default: 0 }, intent: string, lex: string, vec: string, hyde: string, index: string,
  target: string, targets: stringArray, fromLine: number, lineCount: number, lineLimit: number, maxBytes: number, lineNumbers: boolean, fullPath: boolean,
} as const;
const contextProperties = { concept: string, folder: string, property: string, value: string, wikilink: string, query: string, limit: number, maxNeighbors: number, useCache: boolean,
  semanticEnabled: boolean, semanticCollection: string, semanticLimit: number, semanticScope: { ...string, enum: ["global", "graph"] }, semanticMode: searchProperties.mode, semanticIntent: string, semanticSearches: searchProperties.searches, semanticLex: string, semanticVec: string, semanticHyde: string, semanticMinScore: number, semanticAll: boolean, semanticFormat: { ...string, enum: ["json", "files"] }, semanticFull: boolean, semanticLineNumbers: boolean, semanticFullPath: boolean, semanticIndex: string, semanticChunkStrategy: string, semanticCandidateLimit: number, semanticNoRerank: boolean, semanticHydrate: { ...string, enum: ["none", "top", "all", "targets"] }, semanticHydrateTargets: stringArray, semanticHydrateLineLimit: number, semanticHydrateMaxBytes: number, semanticHydrateFromLine: number, semanticHydrateLineCount: number } as const;
// `folder` + `filename` is a supported addressing form that writeNote still
// accepts. With `additionalProperties: false` a strict schema is only as
// complete as its property list, so omitting them silently removed a real
// capability from every schema-driven client while raw SDK calls kept working.
const writeProperties = {
  notePath: string,
  folder: string,
  filename: string,
  concept: string,
  frontmatter: { type: "object" },
  body: string,
} as const;
const operations: Record<string, readonly Operation[]> = {
  oms_write: [
    { op: "create", name: "write", properties: writeProperties },
    { op: "append", name: "write", properties: writeProperties },
    { op: "update", name: "write", properties: writeProperties },
  ],
  oms_search: [{ op: "axis", name: "oms_retrieve_by_axis", properties: contextProperties }, { op: "context", name: "oms_retrieve_context", properties: contextProperties }, { op: "lazy-load", name: "oms_lazy_load_note", properties: { notePath: string }, required: ["notePath"] }, { op: "concepts", name: "oms_list_concepts" }, { op: "semantic-query", name: "oms_semantic_query", properties: searchProperties }, { op: "semantic-collections", name: "oms_semantic_collections", properties: { index: string } }, { op: "semantic-contexts", name: "oms_semantic_contexts", properties: { index: string } }, { op: "semantic-status", name: "oms_semantic_status", properties: { index: string } }, { op: "get-document", name: "oms_get_document", properties: searchProperties, required: ["target"] }, { op: "multi-get-documents", name: "oms_multi_get_documents", properties: searchProperties }],
  oms_link: [{ op: "suggest", name: "oms_link_suggest", properties: { notePath: string, folder: string }, required: ["notePath"] }, { op: "apply", name: "oms_link_apply", properties: { notePath: string, folder: string, baseContentHash: string, candidateIds: stringArray }, required: ["notePath", "baseContentHash", "candidateIds"] }],
  oms_status: [{ name: "oms_graph_status", direct: true }],
  oms_doctor: [{ op: "audit", name: "oms_vault_audit", properties: { folder: string } }, { op: "validate", name: "oms_validate_contract", properties: { notePath: string }, required: ["notePath"] }, { op: "build-graph", name: "oms_graph_build" }, { op: "semantic-cleanup", name: "oms_semantic_cleanup", properties: { collection: string, index: string } }, { op: "sync-embeddings", name: "oms_sync_embeddings", properties: { collection: string, ensureCollection: boolean, update: boolean, embed: boolean, force: boolean, pull: boolean, index: string, chunkStrategy: string, maxDocsPerBatch: number, maxBatchMb: number } }],
};
function operationSchema(tool: string): Tool["inputSchema"] {
  const toolOperations = operations[tool];
  if (!toolOperations) throw new Error(`Missing MCP operation definition for ${tool}.`);
  if (toolOperations.length === 1 && toolOperations[0]?.direct) {
    const { properties = {}, required = [] } = toolOperations[0];
    return { type: "object", additionalProperties: false, properties, required: [...required] } as Tool["inputSchema"];
  }
  return { type: "object", oneOf: toolOperations.map(({ op, properties = {}, required = [] }) => ({ additionalProperties: false, properties: { op: { ...string, const: op }, ...properties }, required: ["op", ...required] })) } as Tool["inputSchema"];
}
function resolveOperation(tool: string, op: string | undefined): string | undefined {
  return operations[tool]?.find((operation) => operation.direct || operation.op === op)?.name;
}
export const omsMcpTools: Tool[] = [
  { name: "oms_write", title: "Oh My Second Brain write", description: "Write a vault note through the kernel-owned .oms contract.", inputSchema: operationSchema("oms_write"), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "oms_search", title: "Oh My Second Brain search", description: "Retrieve vault context, semantic search, ontology, and selected documents. `op` selects the operation.", inputSchema: operationSchema("oms_search"), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "oms_link", title: "Oh My Second Brain link", description: "Suggest or apply wikilinks; `op` selects the operation.", inputSchema: operationSchema("oms_link"), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
  { name: "oms_status", title: "Oh My Second Brain status", description: "Read-only health and statistics for the active vault.", inputSchema: operationSchema("oms_status"), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "oms_doctor", title: "Oh My Second Brain doctor", description: "Diagnose or repair the vault; `op` selects the operation.", inputSchema: operationSchema("oms_doctor"), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
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

  // Creating semantic engines are shared by all non-search tools, including
  // doctor repairs which must initialize a missing store.
  let semanticEngine: AssembledEngine | null = null;
  const getSemanticEngine = (): AssembledEngine => {
    if (semanticEngine === null) {
      semanticEngine = assembleFullSemanticEngine(vault, opts.reranker);
    }
    return semanticEngine;
  };

  // Core semantic engine (lazy): lex + file-based document reads with NO model.
  // vec/HyDE fail fast (the core store has no vec0 table). This is the model-less
  // backend for the document/retrieve_context paths after the src/search teardown.
  let coreSemanticEngine: AssembledEngine | null = null;
  const getCoreSemanticEngine = (): AssembledEngine => {
    if (coreSemanticEngine === null) {
      coreSemanticEngine = assembleCoreSemanticEngine({ vault, reranker: opts.reranker });
    }
    return coreSemanticEngine;
  };

  // Search owns independent read-only slots so it cannot poison doctor repair.
  let readOnlySemanticEngine: AssembledEngine | null | undefined;
  const getReadOnlySemanticEngine = (): AssembledEngine | null => {
    if (readOnlySemanticEngine === undefined) {
      readOnlySemanticEngine = assembleEngineReadOnly({
        vault,
        embeddingProvider: process.env["OMS_EMBEDDING_PROVIDER"],
        embeddingModel: process.env["OMS_EMBEDDING_MODEL"],
        reranker: opts.reranker,
      });
    }
    return readOnlySemanticEngine;
  };
  let readOnlyCoreSemanticEngine: AssembledEngine | null | undefined;
  const getReadOnlyCoreSemanticEngine = (): AssembledEngine | null => {
    if (readOnlyCoreSemanticEngine === undefined) {
      readOnlyCoreSemanticEngine = assembleCoreSemanticEngineReadOnly({ vault, reranker: opts.reranker });
    }
    return readOnlyCoreSemanticEngine;
  };
  let ephemeralCoreSemanticEngine: AssembledEngine | null = null;
  let ephemeralCoreSemanticEnginePromise: Promise<AssembledEngine> | null = null;
  const getEphemeralCoreSemanticEngine = async (): Promise<AssembledEngine> => {
    if (ephemeralCoreSemanticEngine !== null) return ephemeralCoreSemanticEngine;
    if (ephemeralCoreSemanticEnginePromise === null) {
      ephemeralCoreSemanticEnginePromise = (async () => {
        const assembled = assembleEphemeralCoreSemanticEngine({ vault, reranker: opts.reranker });
        ephemeralCoreSemanticEngine = assembled;
        return assembled;
      })().catch((error: unknown) => {
        ephemeralCoreSemanticEnginePromise = null;
        throw error;
      });
    }
    return ephemeralCoreSemanticEnginePromise;
  };

  // A real embedding provider is configured iff the canonical pair is set
  // (ADR-007). The engine's model-OPTIONAL surface (document reads,
  // retrieve_context's semantic leg, ReadResource) keys off this to decide
  // vec-capable vs core engine WITHOUT a no-model assembly throw.
  const hasEmbeddingModel = embeddingConfigPresent;

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
    if (publicName === "oms_search") return resolveReadOnlyDocumentAdapter();
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
  const hasExplicitEmbeddingIntent = (args: Record<string, unknown> | undefined): boolean =>
    requiresEmbeddings({
      mode: args?.["mode"] === "vsearch" ? "vsearch" : undefined,
      vec: stringArg(args, "vec"),
      hyde: stringArg(args, "hyde"),
      searches: Array.isArray(args?.["searches"])
        ? args["searches"].flatMap((search) =>
          isRecord(search) &&
          (search["type"] === "lex" || search["type"] === "vec" || search["type"] === "hyde") &&
          typeof search["query"] === "string"
            ? [{ type: search["type"], query: search["query"] }]
            : [])
        : undefined,
    });
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
    if (semanticEngine !== null) {
      void semanticEngine.dispose().catch(() => undefined);
    }
    if (coreSemanticEngine !== null) {
      void coreSemanticEngine.dispose().catch(() => undefined);
    }
    if (readOnlySemanticEngine !== null && readOnlySemanticEngine !== undefined) {
      void readOnlySemanticEngine.dispose().catch(() => undefined);
    }
    if (readOnlyCoreSemanticEngine !== null && readOnlyCoreSemanticEngine !== undefined) {
      void readOnlyCoreSemanticEngine.dispose().catch(() => undefined);
    }
    if (ephemeralCoreSemanticEngine !== null) {
      void ephemeralCoreSemanticEngine.dispose().catch(() => undefined);
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: omsMcpTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    let args = isRecord(request.params.arguments) ? request.params.arguments : undefined;
    const publicName = request.params.name;
    const op = publicName === "oms_write" ? stringArg(args, "op") ?? "create" : stringArg(args, "op");
    const name = resolveOperation(publicName, op);
    if (!name) return errorText(`Unknown Oh My Second Brain tool: ${publicName}`);
    if (publicName === "oms_write") args = { ...args, mode: op };
    if (publicName === "oms_search" && op === "semantic-query") {
      const searches = args?.["searches"];
      if (typeof args?.["query"] === "string" && Array.isArray(searches)) {
        return errorText('Provide exactly one of "query" or "searches" for semantic-query.');
      }
    }
    if (name === "oms_graph_status") {
      // The src/graph derived-cache ledger (M3 5-state staleness) is the source
      // of truth for retrieve_context's optional warm cache and stays intact.
      // engineGraph is additive: it surfaces the native engine's axis cache that
      // backs oms_retrieve_by_axis, so the graph-only swap is observable here.
      // Defensive .catch: graphStatus reads the cache-meta ledger before the
      // try below; a future tightening of its error contract must not let a
      // throw escape ALL inner catch branches and break the MCP handler.
      const engineGraph = await engine.adapter.graphStatus(vault).catch(() => null);
      try {
        const { ontology, source: ontologySource } = await resolveActiveOntology(vault);
        const cacheStatus = await graphCacheStatus(vault, ontology);
        return jsonText({
          vault,
          ontologySource,
          sourceOfTruth: ["markdown notes", ".oms/taxonomy.yaml", ".oms/concepts/*.yaml"],
          counts: {
            concepts: ontology.concepts.size,
            folders: Object.keys(ontology.taxonomy.folders).length,
          },
          derivedState: cacheStatus,
          engineGraph,
          writeTools:
            source === "cwd"
              ? "oms_write-disabled-target-unverified"
              : "oms_write-gated-by-verified-target-and-contract",
          readTools: omsMcpTools.map((tool) => tool.name),
        });
      } catch (error) {
        return jsonText({
          vault,
          ontologySource: "vault-invalid",
          sourceOfTruth: ["markdown notes", ".oms/taxonomy.yaml", ".oms/concepts/*.yaml"],
          error: error instanceof Error ? error.message : String(error),
          counts: null,
          derivedState: {
            exists: false,
            staleness: {
              schemaStale: true,
              graphStale: true,
              searchStale: true,
              embeddingStale: "not-configured",
              validationStale: true,
              reasons: ["local .oms exists but could not be loaded"],
            },
          },
          engineGraph,
          writeTools: "oms_write-disabled-invalid-ontology",
          readTools: ["oms_graph_status"],
        });
      }
    }

    try {
    if (name === "oms_graph_build" || name === "oms_semantic_cleanup" || name === "oms_sync_embeddings") {
      const operation = name === "oms_graph_build" ? "build-graph" : name === "oms_semantic_cleanup" ? "semantic-cleanup" : "sync-embeddings";
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
      const resolveRepairAdapter = operation === "build-graph"
        ? undefined
        : (): McpEngineAdapter =>
            publicName === "oms_search"
              ? resolveReadOnlyDocumentAdapter()
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

    if (name === "oms_list_concepts") {
      const { ontology, source } = await resolveActiveOntology(vault);
      return jsonText({
        vault,
        ontologySource: source,
        folders: ontology.taxonomy.folders,
        concepts: Array.from(ontology.concepts.values()).map(conceptSummary),
      });
    }

    if (name === "oms_retrieve_by_axis") {
      // Engine-owned (graph-only swap): axis-first retrieval over the native
      // node index, built lazily off the filesystem — no embedding model needed.
      const limitValue = args?.["limit"];
      const result = await engine.adapter.retrieveByAxis({
        concept: stringArg(args, "concept"),
        folder: stringArg(args, "folder"),
        property: stringArg(args, "property"),
        value: stringArg(args, "value"),
        wikilink: stringArg(args, "wikilink"),
        query: stringArg(args, "query"),
        limit: typeof limitValue === "number" ? limitValue : undefined,
      });
      // Axis metadata (concept/folder/axes/wikilinks) is carried inside each
      // hit's `context` field as a JSON string — callers must parse it (RISK-6).
      return jsonText({
        vault,
        mode: "axis-first-search-second",
        bodyPolicy: "lazy-load",
        ...result,
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
      const { ontology, source } = await resolveActiveOntology(vault);
      const limitValue = args?.["limit"];
      const maxNeighborsValue = args?.["maxNeighbors"];
      const useCacheValue = args?.["useCache"];
      const result = await retrieveMorningContext(
        {
          vault,
          ontology,
          concept: stringArg(args, "concept"),
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
        ontologySource: source,
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
        const query = stringArg(args, "query");
        const vec = stringArg(args, "vec");
        const hyde = stringArg(args, "hyde");
        const noPersistentReadOnlyIndex = hasEmbeddingModel()
          ? getReadOnlySemanticEngine() === null
          : getReadOnlyCoreSemanticEngine() === null;
        if (query !== undefined && !hasExplicitEmbeddingIntent(args) && noPersistentReadOnlyIndex) {
          const result = await (await getEphemeralCoreSemanticEngine()).adapter.semanticQuery({
            vault,
            query,
            lex: stringArg(args, "lex") ?? query,
            limit: typeof args?.["limit"] === "number" ? args["limit"] : undefined,
            minScore: typeof args?.["minScore"] === "number" ? args["minScore"] : undefined,
            intent: stringArg(args, "intent"),
            collection: stringArg(args, "collection"),
            index: stringArg(args, "index"),
          });
          return jsonText(result);
        }
        const requestOptions = {
          limit: typeof args?.["limit"] === "number" ? args["limit"] : undefined,
          candidateLimit: typeof args?.["candidateLimit"] === "number" ? args["candidateLimit"] : undefined,
          rerank: typeof args?.["rerank"] === "boolean" ? args["rerank"] : undefined,
          minScore: typeof args?.["minScore"] === "number" ? args["minScore"] : undefined,
          intent: stringArg(args, "intent"),
          collection: stringArg(args, "collection"),
          collections: Array.isArray(args?.["collections"])
            ? args["collections"].filter((collection): collection is string => typeof collection === "string")
            : undefined,
          mode: stringArg(args, "mode") as "query" | "search" | "vsearch" | undefined,
          lex: stringArg(args, "lex"),
          vec,
          hyde,
          index: stringArg(args, "index"),
        };
        const result = await searchBackend.search({
          ...requestOptions,
          // `query` is the default lexical representation. An explicit vector
          // or HyDE shorthand selects its own representation instead; only
          // `query` plus typed `searches` is contradictory.
          query: vec !== undefined || hyde !== undefined ? undefined : query,
          searches: Array.isArray(args?.["searches"])
            ? args["searches"] as McpSemanticTypedSearch[]
            : undefined,
        });
        return jsonText(result);
      }
      const useEphemeralLexicalFallback =
        name === "oms_semantic_query" &&
        publicName === "oms_search" &&
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
          ? publicName === "oms_search"
            ? resolveReadOnlyIndexAdapter()
            : getSemanticEngine().adapter
          : isEngineDocumentOp(name)
            ? resolveDocumentAdapter(publicName)
            : publicName === "oms_search"
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

    if (name === "oms_lazy_load_note") {
      const notePath = stringArg(args, "notePath");
      if (!notePath) {
        return errorText('Missing required string argument "notePath".');
      }
      return jsonText(await lazyLoadNoteBody(vault, notePath));
    }

    if (name === "oms_validate_contract") {
      const notePath = stringArg(args, "notePath");
      if (!notePath) {
        return errorText('Missing required string argument "notePath".');
      }

      let fullPath: string;
      try {
        fullPath = safeVaultNotePath(vault, notePath);
      } catch (error) {
        return errorText(error instanceof Error ? error.message : String(error));
      }

      const { ontology, source } = await resolveActiveOntology(vault);
      const normalizedNotePath = path.relative(vault, fullPath).replace(/\\/g, "/");
      const concept = resolveConcept(ontology, normalizedNotePath);
      if (!concept) {
        return jsonText({
          vault,
          ontologySource: source,
          notePath: normalizedNotePath,
          concept: null,
          valid: false,
          violations: [
            {
              field: "path",
              rule: "folder-binding",
              message: "No concept binding resolves for this note path.",
            },
          ],
        });
      }

      const raw = await readFile(fullPath, "utf-8");
      const { frontmatter, hasFrontmatter } = parseNote(raw);
      const result = validateFrontmatter(frontmatter, concept);
      return jsonText({
        vault,
        ontologySource: source,
        notePath: normalizedNotePath,
        concept: concept.concept,
        hasFrontmatter,
        valid: result.valid,
        violations: result.violations,
      });
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
      const { ontology, source } = await resolveActiveOntology(vault);
      const report = await lintVault(vault, ontology, { folder });
      return jsonText({
        vault,
        ontologySource: source,
        folder: folder ?? null,
        scannedNotes: report.scannedNotes,
        excludedNotes: report.excludedNotes,
        clean: report.clean,
        violations: report.violations,
      });
    }

    if (name === "oms_link_suggest") {
      const notePath = stringArg(args, "notePath");
      if (!notePath) {
        return errorText('Missing required string argument "notePath".');
      }
      const { ontology, source: ontologySource } = await resolveActiveOntology(vault);
      const suggestion = await suggestLinksForNote(
        { vault, source, ontology, notePath },
        { folder: stringArg(args, "folder") },
      );
      return jsonText({ vault, ontologySource, ...suggestion });
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
      const { ontology, source: ontologySource } = await resolveActiveOntology(vault);
      const outcome = await applyLinksForNote(
        { vault, source, ontology, notePath },
        { baseContentHash, candidateIds: idsArg.filter((id): id is string => typeof id === "string") },
        { folder: stringArg(args, "folder") },
      );
      return jsonText({ vault, ontologySource, ...linkApplyPayload(outcome) });
    }

    if (name === "write") {
      const { ontology, source: ontologySource } = await resolveActiveOntology(vault);
      const modeArg = stringArg(args, "mode");
      const mode: WriteMode = isWriteMode(modeArg) ? modeArg : "create";

      // `notePath` and `folder`/`filename` are two ways to address the same
      // note. Supplying both is a contradiction the caller should hear about:
      // silently preferring one produced a response that reported the concept
      // implied by one form and the folder implied by the other, which reads as
      // corruption rather than as the input error it is.
      const hasNotePath = stringArg(args, "notePath") !== undefined;
      const hasFolderForm = stringArg(args, "folder") !== undefined || stringArg(args, "filename") !== undefined;
      if (hasNotePath && hasFolderForm) {
        return errorText(
          'Provide either "notePath" or "folder"/"filename" to address the note, not both.',
        );
      }

      const frontmatterArg = args?.["frontmatter"];
      const result = await writeNote({
        target: { vault, source },
        ontology,
        mode,
        dryRun: false,
        concept: stringArg(args, "concept"),
        folder: stringArg(args, "folder"),
        filename: stringArg(args, "filename"),
        notePath: stringArg(args, "notePath"),
        frontmatter: isRecord(frontmatterArg) ? frontmatterArg : undefined,
        body: stringArg(args, "body"),
      });
      return jsonText({
        vault,
        ontologySource,
        ...result,
        resolvedVault: vault,
        resolutionSource: source,
      });
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
