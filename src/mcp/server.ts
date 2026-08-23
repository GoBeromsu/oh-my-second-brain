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
import { parseNote } from "../conventions/frontmatter.js";
import { validateFrontmatter } from "../conventions/validate.js";
import { lintVault } from "../engine/conventions/vault-lint.js";
import {
  safeVaultNotePath,
  writeNote,
  type WriteMode,
} from "../capture/safe.js";
import {
  buildGraphCache,
  graphCacheStatus,
  graphCachePath,
  lazyLoadNoteBody,
} from "../graph/cache.js";
import type { WriteTargetSource } from "../conventions/write-protocol.js";
import { readBundledPackageVersion } from "../core/runtime/assets.js";
import { resolveActiveOntology } from "../ontology/active.js";
import { resolveConcept } from "../core/ontology/resolver.js";
import { retrieveMorningContext } from "../retrieve/morning.js";
import { makeEngineMorningBackend } from "./engine-morning-backend.js";
import type { Concept } from "../core/ontology/types.js";
import {
  handleSemanticTool,
  isEngineSemanticOp,
  isEngineDocumentOp,
  isModelOptionalSemanticQueryOp,
  semanticOptionsFromArgs,
  retrieveContextSemanticInputProperties,
} from "./semantic-retrieve.js";
import { assembleCoreSemanticEngine, assembleGraphOnlyEngine, type AssembledEngine } from "../engine/assemble.js";
import { assembleFullSemanticEngine, embeddingConfigPresent } from "./semantic-engine.js";
import { applyLinksForNote, linkApplyPayload, suggestLinksForNote } from "./link-tools.js";
import type { McpEngineAdapter } from "../engine/mcp/facade.js";
import {
  buildServerInstructions,
  cachedUpdateNotice,
  scheduleUpdateNoticeRefresh,
} from "./update-notice.js";

const SERVER_VERSION = readBundledPackageVersion();

export const BASE_SERVER_INSTRUCTIONS =
  "Oh My Second Brain exposes write, search, link, status, and doctor tools. oms_write is gated by a verified vault target (a vault inferred from the current directory is refused), vault confinement, and contract validation.";

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

export const omsMcpTools: Tool[] = [
  {
    name: "oms_write", title: "Oh My Second Brain write",
    description: "Write a vault note through the kernel-owned .oms contract.",
    inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["create", "append", "update"] }, notePath: { type: "string" }, concept: { type: "string" }, folder: { type: "string" }, filename: { type: "string" }, frontmatter: { type: "object" }, body: { type: "string" } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "oms_search", title: "Oh My Second Brain search",
    description: "Read vault retrieval, semantic search, ontology, and selected documents. `op` selects the operation.",
    inputSchema: { type: "object", properties: { op: { type: "string", enum: ["axis", "context", "lazy-load", "concepts", "semantic-query", "semantic-collections", "semantic-contexts", "semantic-status", "get-document", "multi-get-documents"] }, query: { type: "string" }, searches: { type: "array", maxItems: 10, items: { type: "object", properties: { type: { type: "string", enum: ["lex", "vec", "hyde"] }, query: { type: "string" } }, required: ["type", "query"] } }, limit: { type: "number", default: 10 }, minScore: { type: "number", default: 0 }, collections: { type: "array", items: { type: "string" } }, intent: { type: "string" }, concept: { type: "string" }, folder: { type: "string" }, property: { type: "string" }, value: { type: "string" }, wikilink: { type: "string" }, notePath: { type: "string" }, target: { type: "string" }, targets: { type: "array", items: { type: "string" } }, maxNeighbors: { type: "number" }, useCache: { type: "boolean" }, ...retrieveContextSemanticInputProperties }, required: ["op"] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "oms_link", title: "Oh My Second Brain link",
    description: "Suggest or apply wikilinks; `op` is suggest or apply.",
    inputSchema: { type: "object", properties: { op: { type: "string", enum: ["suggest", "apply"] }, notePath: { type: "string" }, folder: { type: "string" }, baseContentHash: { type: "string" }, candidateIds: { type: "array", items: { type: "string" } } }, required: ["op", "notePath"] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "oms_status", title: "Oh My Second Brain status",
    description: "Read-only health and statistics for the active vault.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "oms_doctor", title: "Oh My Second Brain doctor",
    description: "Diagnose or repair the vault; `op` selects the operation.",
    inputSchema: { type: "object", properties: { op: { type: "string", enum: ["audit", "validate", "build-graph", "semantic-cleanup", "sync-embeddings"] }, notePath: { type: "string" }, folder: { type: "string" }, collection: { type: "string" }, index: { type: "string" }, ensureCollection: { type: "boolean" }, update: { type: "boolean" }, embed: { type: "boolean" }, force: { type: "boolean" }, pull: { type: "boolean" } }, required: ["op"] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

export interface OMSMcpServerOptions {
  vault: string;
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

  // Native engine — semantic layer (lazy): assembled on the FIRST semantic op,
  // not at boot, so boot stays stateless (R2). The vec-capable engine opens the
  // engine SQLite store on construction and loads the embedding model on first
  // embed(). Embedding selection is canonical and explicit: OMS_EMBEDDING_PROVIDER
  // (e.g. gguf | upstage) + OMS_EMBEDDING_MODEL (path or model id). Absent either,
  // assembleFullSemanticEngine throws a loud, actionable error (ADR-007: no
  // hash/fake fallback, no auto-detect) that surfaces via the dispatch catch.
  let semanticEngine: AssembledEngine | null = null;
  const getSemanticEngine = (): AssembledEngine => {
    if (semanticEngine === null) {
      semanticEngine = assembleFullSemanticEngine(vault);
    }
    return semanticEngine;
  };

  // Core semantic engine (lazy): lex + file-based document reads with NO model.
  // vec/HyDE fail fast (the core store has no vec0 table). This is the model-less
  // backend for the document/retrieve_context paths after the src/search teardown.
  let coreSemanticEngine: AssembledEngine | null = null;
  const getCoreSemanticEngine = (): AssembledEngine => {
    if (coreSemanticEngine === null) {
      coreSemanticEngine = assembleCoreSemanticEngine({ vault });
    }
    return coreSemanticEngine;
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
  const resolveDocumentAdapter = (): McpEngineAdapter =>
    hasEmbeddingModel() ? getSemanticEngine().adapter : getCoreSemanticEngine().adapter;

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
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: omsMcpTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    let args = isRecord(request.params.arguments) ? request.params.arguments : undefined;
    const publicName = request.params.name;
    const op = stringArg(args, "op");
    const name = publicName === "oms_status" ? "oms_graph_status"
      : publicName === "oms_write" ? "write"
      : publicName === "oms_link" && op === "suggest" ? "oms_link_suggest"
      : publicName === "oms_link" && op === "apply" ? "oms_link_apply"
      : publicName === "oms_doctor" ? ({ audit: "oms_vault_audit", validate: "oms_validate_contract", "build-graph": "oms_graph_build", "semantic-cleanup": "oms_semantic_cleanup", "sync-embeddings": "oms_sync_embeddings" } as Record<string, string>)[op ?? ""]
      : publicName === "oms_search" ? ({ axis: "oms_retrieve_by_axis", context: "oms_retrieve_context", "lazy-load": "oms_lazy_load_note", concepts: "oms_list_concepts", "semantic-query": "oms_semantic_query", "semantic-collections": "oms_semantic_collections", "semantic-contexts": "oms_semantic_contexts", "semantic-status": "oms_semantic_status", "get-document": "oms_get_document", "multi-get-documents": "oms_multi_get_documents" } as Record<string, string>)[op ?? ""]
      : undefined;
    if (!name) return errorText(`Unknown Oh My Second Brain tool: ${publicName}`);
    if (publicName === "oms_search" && op === "semantic-query") {
      const searches = args?.["searches"];
      if ((typeof args?.["query"] === "string") === Array.isArray(searches)) {
        return errorText('Provide exactly one of "query" or "searches" for semantic-query.');
      }
      if (Array.isArray(searches)) {
        const mapped = Object.fromEntries(searches.flatMap((search) =>
          isRecord(search) && typeof search.type === "string" && typeof search.query === "string"
            ? [[search.type, search.query]]
            : [],
        ));
        args = { ...args, ...mapped, query: "" };
      }
      const collections = args?.["collections"];
      if (Array.isArray(collections) && collections.every((value) => typeof value === "string")) {
        args = { ...args, collection: collections[0] };
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
    if (name === "oms_graph_build") {
      const { ontology, source } = await resolveActiveOntology(vault);
      const cache = await buildGraphCache({ vault, ontology, write: true });
      return jsonText({
        vault,
        ontologySource: source,
        cachePath: graphCachePath(vault),
        generatedAt: cache.generatedAt,
        notes: cache.notes.length,
        edges: cache.edges.length,
        searchDocuments: cache.search.length,
        sourceOfTruth: cache.sourceOfTruth,
      });
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
      const semanticBackend = makeEngineMorningBackend(resolveDocumentAdapter(), vault);
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
          semantic: semanticOptionsFromArgs(args),
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
      const semanticAdapter =
        isEngineSemanticOp(name) && !isModelOptionalSemanticQueryOp(name, args, vault)
          ? getSemanticEngine().adapter
          : resolveDocumentAdapter();
      const semanticToolResult = await handleSemanticTool(name, args, vault, semanticAdapter);
      if (semanticToolResult) {
        return semanticToolResult.ok ? jsonText(semanticToolResult.value) : errorText(semanticToolResult.message);
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
