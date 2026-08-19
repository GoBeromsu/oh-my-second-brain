import { readFile } from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
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
  semanticMcpTools,
  semanticOptionsFromArgs,
  retrieveContextSemanticInputProperties,
} from "./semantic-retrieve.js";
import { assembleCoreSemanticEngine, assembleGraphOnlyEngine, type AssembledEngine } from "../engine/assemble.js";
import { assembleFullSemanticEngine, embeddingConfigPresent } from "./semantic-engine.js";
import type { McpEngineAdapter } from "../engine/mcp/facade.js";
import {
  buildServerInstructions,
  cachedUpdateNotice,
  scheduleUpdateNoticeRefresh,
} from "./update-notice.js";

const SERVER_VERSION = readBundledPackageVersion();

export const BASE_SERVER_INSTRUCTIONS =
  "Oh My Second Brain exposes ontology/status/cache/retrieval tools and the write tool. write is gated by a verified vault target (a vault inferred from the current directory is refused), vault confinement, and contract validation.";

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
    name: "oms_graph_status",
    title: "Oh My Second Brain graph/status",
    description:
      "Read-only status for the active Oh My Second Brain ontology, graph/search cache phase, and gated write-tool posture.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "oms_graph_build",
    title: "Oh My Second Brain graph build",
    description:
      "Build the derived graph/search cache from markdown, frontmatter, folders, and wikilinks.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "oms_list_concepts",
    title: "Oh My Second Brain list concepts",
    description:
      "Read the active ontology concepts, frontmatter axes, folder bindings, and retrieval views.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "oms_retrieve_by_axis",
    title: "Oh My Second Brain retrieve by axis",
    description:
      "Axis-first retrieval over the derived cache; optional lexical query only ranks inside the narrowed candidate set.",
    inputSchema: {
      type: "object",
      properties: {
        concept: { type: "string" },
        folder: { type: "string" },
        property: { type: "string" },
        value: { type: "string" },
        wikilink: { type: "string" },
        query: { type: "string" },
        limit: { type: "number" },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "oms_retrieve_context",
    title: "Oh My Second Brain retrieve context",
    description:
      "Live local graph retrieval with axis seeds, frontmatter/wikilink neighbors, optional OMS semantic candidates, and no warm-cache requirement.",
    inputSchema: {
      type: "object",
      properties: {
        concept: { type: "string" },
        folder: { type: "string" },
        property: { type: "string" },
        value: { type: "string" },
        wikilink: { type: "string" },
        query: { type: "string" },
        limit: { type: "number" },
        maxNeighbors: { type: "number" },
        useCache: { type: "boolean" },
        ...retrieveContextSemanticInputProperties,
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  ...semanticMcpTools,
  {
    name: "oms_lazy_load_note",
    title: "Oh My Second Brain lazy-load note body",
    description:
      "Load a selected note body only after axis/search narrowing has selected the note.",
    inputSchema: {
      type: "object",
      properties: {
        notePath: {
          type: "string",
          description: "Vault-relative markdown note path.",
        },
      },
      required: ["notePath"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "oms_validate_contract",
    title: "Oh My Second Brain validate contract",
    description:
      "Read one vault note and validate its frontmatter against the active folder/concept contract.",
    inputSchema: {
      type: "object",
      properties: {
        notePath: {
          type: "string",
          description: "Vault-relative markdown note path, for example references/book.md.",
        },
      },
      required: ["notePath"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "oms_vault_audit",
    title: "Oh My Second Brain vault audit",
    description:
      "Scan vault notes against the active ontology and return a structured violation report. Read-only; the CLI counterpart is `oms audit`.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "Restrict the scan to one top-level vault folder, for example \"references\".",
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "write",
    title: "Oh My Second Brain write",
    description:
      "Write a vault note through the kernel-owned .oms contract. Modes: create, append, update. Returns ask, inbox, written, or rejected.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["create", "append", "update"] },
        notePath: { type: "string" },
        concept: { type: "string" },
        folder: { type: "string" },
        filename: { type: "string" },
        frontmatter: { type: "object" },
        body: { type: "string" },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
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

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: "qmd://{path}",
        name: "QMD-compatible OMS semantic document",
        description: "Read a native OMS semantic-index document by qmd:// vault-relative path.",
        mimeType: "text/markdown",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    // Resource reads hydrate on the SAME backend the semantic ops use: the engine
    // (file-based, qmd:// / oms:// scheme aware), vec-capable when a model is
    // configured and core (lex + file reads) otherwise — so a retrieve_context
    // docid resolves through the URI surface regardless of which backend produced it.
    const result = await resolveDocumentAdapter().getDocument({ vault, target: uri });
    if (!result.available || !result.documents[0]) {
      throw new Error(
        !result.available && result.reason ? result.reason : "OMS semantic resource not found.",
      );
    }
    return {
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: result.documents[0].content,
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = isRecord(request.params.arguments) ? request.params.arguments : undefined;

    if (request.params.name === "oms_graph_status") {
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
              ? "write-disabled-target-unverified"
              : "write-gated-by-verified-target-and-contract",
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
          writeTools: "disabled-invalid-ontology",
          readTools: ["oms_graph_status"],
        });
      }
    }

    try {
    if (request.params.name === "oms_graph_build") {
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

    if (request.params.name === "oms_list_concepts") {
      const { ontology, source } = await resolveActiveOntology(vault);
      return jsonText({
        vault,
        ontologySource: source,
        folders: ontology.taxonomy.folders,
        concepts: Array.from(ontology.concepts.values()).map(conceptSummary),
      });
    }

    if (request.params.name === "oms_retrieve_by_axis") {
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

    if (request.params.name === "oms_retrieve_context") {
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
    if (isEngineSemanticOp(request.params.name) || isEngineDocumentOp(request.params.name)) {
      const semanticAdapter =
        isEngineSemanticOp(request.params.name) && !isModelOptionalSemanticQueryOp(request.params.name, args, vault)
          ? getSemanticEngine().adapter
          : resolveDocumentAdapter();
      const semanticToolResult = await handleSemanticTool(request.params.name, args, vault, semanticAdapter);
      if (semanticToolResult) {
        return semanticToolResult.ok ? jsonText(semanticToolResult.value) : errorText(semanticToolResult.message);
      }
    }

    if (request.params.name === "oms_lazy_load_note") {
      const notePath = stringArg(args, "notePath");
      if (!notePath) {
        return errorText('Missing required string argument "notePath".');
      }
      return jsonText(await lazyLoadNoteBody(vault, notePath));
    }

    if (request.params.name === "oms_validate_contract") {
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

    if (request.params.name === "oms_vault_audit") {
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

    if (request.params.name === "write") {
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

    return errorText(`Unknown Oh My Second Brain tool: ${request.params.name}`);
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
  scheduleUpdateNoticeRefresh({ installedVersion: SERVER_VERSION });
}

function isWriteMode(value: string | undefined): value is WriteMode {
  return value === "create" || value === "append" || value === "update";
}
