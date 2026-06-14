import { readFile, readdir, stat } from "node:fs/promises";
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
import {
  commitCapture,
  prepareCapture,
  safeVaultNotePath,
  type CaptureWriteMode,
} from "../capture/safe.js";
import {
  buildGraphCache,
  graphCacheStatus,
  graphCachePath,
  lazyLoadNoteBody,
} from "../graph/cache.js";
import { loadOntology } from "../ontology/loader.js";
import { resolveConcept } from "../ontology/resolver.js";
import { retrieveMorningContext } from "../retrieve/morning.js";
import { makeEngineMorningBackend } from "./engine-morning-backend.js";
import { resolveBundledAssetPaths } from "../runtime/assets.js";
import type { Concept, Ontology } from "../ontology/types.js";
import {
  handleSemanticTool,
  isEngineSemanticOp,
  isEngineDocumentOp,
  semanticMcpTools,
  semanticOptionsFromArgs,
  retrieveContextSemanticInputProperties,
} from "./semantic-retrieve.js";
import { getSemanticDocument } from "../search/semantic.js";
import { assembleEngine, assembleGraphOnlyEngine, type AssembledEngine } from "../engine/assemble.js";
import type { McpEngineAdapter } from "../engine/mcp/facade.js";

const SERVER_VERSION = "0.0.0";
const bundledAssets = resolveBundledAssetPaths();

async function activeOntology(vault: string): Promise<{ ontology: Ontology; source: string }> {
  const localOntologyDir = path.join(vault, ".oms");
  const omsKind = await pathKind(localOntologyDir);
  if (omsKind === "missing") {
    return { ontology: await loadOntology(bundledAssets.ontologyDir), source: "bundled" };
  }
  if (omsKind !== "directory") {
    throw new Error("Local .oms exists but is not a directory.");
  }

  const taxonomyKind = await pathKind(path.join(localOntologyDir, "taxonomy.yaml"));
  const conceptsKind = await pathKind(path.join(localOntologyDir, "concepts"));

  if (taxonomyKind === "missing" && conceptsKind === "missing") {
    return { ontology: await loadOntology(bundledAssets.ontologyDir), source: "bundled" };
  }
  if (taxonomyKind !== "file" || conceptsKind !== "directory") {
    throw new Error(
      "Local .oms ontology is incomplete; expected .oms/taxonomy.yaml and .oms/concepts/.",
    );
  }

  return { ontology: await loadOntology(localOntologyDir), source: "vault" };
}

async function pathKind(target: string): Promise<"missing" | "file" | "directory" | "other"> {
  try {
    const info = await stat(target);
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

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
    name: "oms_capture_prepare",
    title: "Oh My Second Brain capture prepare",
    description:
      "Plan a safe capture: choose folder/concept, surface missing fields, or route ambiguous input to inbox without writing.",
    inputSchema: {
      type: "object",
      properties: {
        concept: { type: "string" },
        folder: { type: "string" },
        filename: { type: "string" },
        frontmatter: { type: "object" },
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
    name: "oms_capture_commit",
    title: "Oh My Second Brain capture commit",
    description:
      "Write or append a note only after vault path confinement and contract validation pass.",
    inputSchema: {
      type: "object",
      properties: {
        notePath: { type: "string" },
        frontmatter: { type: "object" },
        body: { type: "string" },
        mode: { type: "string", enum: ["create", "append"] },
      },
      required: ["notePath", "frontmatter", "body", "mode"],
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
}

export function createOMSMcpServer(opts: OMSMcpServerOptions): Server {
  const vault = path.resolve(opts.vault);

  // Native engine — graph layer (boot): assembled model-free via deferred
  // (throw-on-use) embedding primitives. Axis-first retrieval and the derived
  // graph cache status scan the vault off the filesystem and need no model.
  // No model load, no SQLite store, no watcher: side-effect-free per boot (R2).
  const engine = assembleGraphOnlyEngine({ vault });

  // Native engine — semantic layer (lazy): assembled on the FIRST semantic op,
  // not at boot, so boot stays stateless (R2). assembleEngine opens the engine
  // SQLite store on construction and loads the embedding model on first embed().
  // Golden-set parity is verified (engine >= 1.7x the src/search baseline recall@10
  // on every query type), so the engine now owns semantic query/status/sync/
  // collections/contexts/cleanup. Requires a real model: OMS_MODEL_PATH (GGUF) or
  // UPSTAGE_API_KEY — absent both, assembleEngine throws a loud, actionable error
  // (ADR-007: no hash/fake fallback) that surfaces via the dispatch catch below.
  let semanticEngine: AssembledEngine | null = null;
  const getSemanticEngine = (): AssembledEngine => {
    if (semanticEngine === null) {
      const modelPath = process.env["OMS_MODEL_PATH"];
      semanticEngine = assembleEngine({ vault, ...(modelPath ? { modelPath } : {}) });
    }
    return semanticEngine;
  };

  // A real embedding model is configured iff one of these is set (ADR-007). The
  // engine's model-OPTIONAL surface (document reads, retrieve_context's semantic
  // leg, ReadResource) keys off this to decide engine vs src/search WITHOUT
  // triggering an assembly throw on a model-less host.
  const hasEmbeddingModel = (): boolean =>
    Boolean(process.env["OMS_MODEL_PATH"] ?? process.env["UPSTAGE_API_KEY"]);

  // Lenient adapter resolver for those model-optional paths: returns the engine
  // adapter only when a model is configured AND assembly succeeds, else null so
  // the caller degrades to the model-free src/search layer. This is the deliberate
  // counterpart to the isEngineSemanticOp path, which assembles eagerly and lets
  // the no-model error surface loudly (ADR-007). Both honor the same invariant:
  // query + document reads resolve on the SAME backend, so a retrieve_context
  // real-path docid always hydrates where it was produced (no split-brain).
  const trySemanticEngineAdapter = (): McpEngineAdapter | null => {
    if (!hasEmbeddingModel()) return null;
    try {
      return getSemanticEngine().adapter;
    } catch {
      return null;
    }
  };

  const server = new Server(
    { name: "oms", version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        "Oh My Second Brain exposes ontology/status/cache/retrieval tools and safe capture tools. Capture commit is gated by vault confinement and contract validation.",
    },
  );

  server.onclose = () => {
    void engine.dispose().catch(() => undefined);
    if (semanticEngine !== null) {
      void semanticEngine.dispose().catch(() => undefined);
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
    // (file-based, qmd:// / oms:// scheme aware) when a model is configured, else
    // src/search — so a retrieve_context docid resolves through the URI surface
    // regardless of which backend produced it.
    const engineAdapter = trySemanticEngineAdapter();
    const result = engineAdapter
      ? await engineAdapter.getDocument({ vault, target: uri })
      : await getSemanticDocument({ vault, target: uri });
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
        const { ontology, source } = await activeOntology(vault);
        const cacheStatus = await graphCacheStatus(vault, ontology);
        return jsonText({
          vault,
          ontologySource: source,
          sourceOfTruth: ["markdown notes", ".oms/taxonomy.yaml", ".oms/concepts/*.yaml"],
          counts: {
            concepts: ontology.concepts.size,
            folders: Object.keys(ontology.taxonomy.folders).length,
          },
          derivedState: cacheStatus,
          engineGraph,
          writeTools: "capture-commit-gated-by-vault-confinement-and-contract-validation",
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
      const { ontology, source } = await activeOntology(vault);
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
      const { ontology, source } = await activeOntology(vault);
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
      // the semantic leg routes to the native engine when a model is configured
      // (parity-verified ranking, real-path docids) and degrades to the model-free
      // src/search backend otherwise. get/multi_get and ReadResource make the SAME
      // model-gated choice, so a docid emitted here always hydrates on the backend
      // that produced it — no split-brain between query and document reads.
      const engineAdapter = trySemanticEngineAdapter();
      const semanticBackend = engineAdapter ? makeEngineMorningBackend(engineAdapter, vault) : undefined;
      const { ontology, source } = await activeOntology(vault);
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

    // Semantic / sync / cleanup ops route to the native engine adapter, lazily
    // assembled (parity verified vs the src/search baseline — golden-set gate).
    // Two adapter-resolution policies:
    //   - isEngineSemanticOp → EAGER getSemanticEngine().adapter: a model-less host
    //     throws a loud ADR-007 error (surfaces via the dispatch catch below).
    //   - isEngineDocumentOp → LENIENT trySemanticEngineAdapter(): model present →
    //     engine (hydrates retrieve_context's real-path docids on the same backend),
    //     absent → null so handleSemanticTool falls back to src/search WITHOUT
    //     forcing engine assembly.
    // Every other tool gets null and never touches the model path.
    const semanticAdapter = isEngineSemanticOp(request.params.name)
      ? getSemanticEngine().adapter
      : isEngineDocumentOp(request.params.name)
        ? trySemanticEngineAdapter()
        : null;
    const semanticToolResult = await handleSemanticTool(request.params.name, args, vault, semanticAdapter);
    if (semanticToolResult) {
      return semanticToolResult.ok ? jsonText(semanticToolResult.value) : errorText(semanticToolResult.message);
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

      const { ontology, source } = await activeOntology(vault);
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

    if (request.params.name === "oms_capture_prepare") {
      const { ontology, source } = await activeOntology(vault);
      const frontmatterArg = args?.["frontmatter"];
      const frontmatter = isRecord(frontmatterArg) ? frontmatterArg : {};
      return jsonText({
        vault,
        ontologySource: source,
        plan: prepareCapture({
          vault,
          ontology,
          concept: stringArg(args, "concept"),
          folder: stringArg(args, "folder"),
          filename: stringArg(args, "filename"),
          frontmatter,
        }),
      });
    }

    if (request.params.name === "oms_capture_commit") {
      const { ontology, source } = await activeOntology(vault);
      const notePath = stringArg(args, "notePath");
      const body = stringArg(args, "body");
      const mode = stringArg(args, "mode");
      const frontmatterArg = args?.["frontmatter"];
      if (!notePath || !body || !isCaptureMode(mode) || !isRecord(frontmatterArg)) {
        return errorText(
          'Missing required arguments: notePath:string, frontmatter:object, body:string, mode:"create"|"append".',
        );
      }
      try {
        return jsonText({
          vault,
          ontologySource: source,
          result: await commitCapture({
            vault,
            ontology,
            notePath,
            frontmatter: frontmatterArg,
            body,
            mode,
          }),
        });
      } catch (error) {
        return errorText(error instanceof Error ? error.message : String(error));
      }
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
}

function isCaptureMode(value: string | undefined): value is CaptureWriteMode {
  return value === "create" || value === "append";
}
