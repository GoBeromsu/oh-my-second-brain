import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const storageProperty = {
  type: "string",
  enum: ["qmd-sqlite", "oms-native-json"],
  description: "Semantic storage backend. Defaults to qmd-sqlite for qmd-compatible SQLite/FTS/vector storage.",
} as const;

const modelPathProperty = {
  type: "string",
  description: "Optional local GGUF embedding model path used for node-llama-cpp embeddings and diagnostics.",
} as const;

const queryInputSchema: Tool["inputSchema"] = {
  type: "object",
  properties: {
    query: { type: "string" },
    collection: { type: "string" },
    mode: { type: "string", enum: ["query", "search", "vsearch"] },
    limit: { type: "number" },
    minScore: { type: "number" },
    intent: { type: "string" },
    lex: { type: "string" },
    vec: { type: "string" },
    hyde: { type: "string" },
    index: { type: "string" },
    storage: storageProperty,
    modelPath: modelPathProperty,
  },
  required: ["query"],
};

const getDocumentInputSchema: Tool["inputSchema"] = {
  type: "object",
  properties: {
    target: {
      type: "string",
      description: "OMS semantic target, path, docid, or line range such as #abc123:120:40.",
    },
    collection: { type: "string" },
    fromLine: { type: "number" },
    lineCount: { type: "number" },
    lineNumbers: { type: "boolean" },
    fullPath: { type: "boolean" },
    index: { type: "string" },
    storage: storageProperty,
    modelPath: modelPathProperty,
  },
  required: ["target"],
};

const multiGetInputSchema: Tool["inputSchema"] = {
  type: "object",
  properties: {
    target: { type: "string" },
    targets: { type: "array", items: { type: "string" } },
    lineLimit: { type: "number" },
    maxBytes: { type: "number" },
    lineNumbers: { type: "boolean" },
    fullPath: { type: "boolean" },
    index: { type: "string" },
    storage: storageProperty,
    modelPath: modelPathProperty,
  },
};

export const semanticMcpTools: Tool[] = [
  {
    name: "oms_sync_embeddings",
    title: "Oh My Second Brain embedding sync",
    description: "Synchronize the active vault into the OMS embedding store before semantic retrieval.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        ensureCollection: { type: "boolean" },
        update: { type: "boolean" },
        embed: { type: "boolean" },
        force: { type: "boolean" },
        pull: { type: "boolean" },
        index: { type: "string" },
        storage: storageProperty,
        modelPath: modelPathProperty,
        chunkStrategy: { type: "string" },
        maxDocsPerBatch: { type: "number" },
        maxBatchMb: { type: "number" },
      },
    },
    annotations: writeAnnotations,
  },
  {
    name: "oms_semantic_query",
    title: "Oh My Second Brain semantic query",
    description: "Run native OMS semantic query/search/vsearch over the active vault without depending on qmd.",
    inputSchema: queryInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "oms_semantic_status",
    title: "Oh My Second Brain semantic status",
    description: "Report native OMS semantic index status, qmd-compatible SQLite/vector metadata, and model diagnostics.",
    inputSchema: { type: "object", properties: { index: { type: "string" }, storage: storageProperty, modelPath: modelPathProperty } },
    annotations: readOnlyAnnotations,
  },
  {
    name: "oms_semantic_collections",
    title: "Oh My Second Brain semantic collections",
    description: "List native OMS semantic collections and stored qmd-compatible collection metadata.",
    inputSchema: { type: "object", properties: { index: { type: "string" }, storage: storageProperty } },
    annotations: readOnlyAnnotations,
  },
  {
    name: "oms_semantic_contexts",
    title: "Oh My Second Brain semantic contexts",
    description: "List native OMS semantic global, collection, and path-prefix contexts.",
    inputSchema: { type: "object", properties: { index: { type: "string" }, storage: storageProperty } },
    annotations: readOnlyAnnotations,
  },
  {
    name: "oms_semantic_cleanup",
    title: "Oh My Second Brain semantic cleanup",
    description: "Remove stale native OMS semantic index entries whose files no longer exist.",
    inputSchema: { type: "object", properties: { index: { type: "string" }, storage: storageProperty } },
    annotations: writeAnnotations,
  },
  {
    name: "oms_get_document",
    title: "Oh My Second Brain get document",
    description: "Read one selected semantic document target, docid, path, or line range without writing to the vault.",
    inputSchema: getDocumentInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "query",
    title: "QMD-compatible semantic query alias",
    description: "Compatibility alias for oms_semantic_query backed by the native OMS semantic index.",
    inputSchema: queryInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "status",
    title: "QMD-compatible semantic status alias",
    description: "Compatibility alias for oms_semantic_status backed by the native OMS semantic index.",
    inputSchema: { type: "object", properties: { index: { type: "string" }, storage: storageProperty, modelPath: modelPathProperty } },
    annotations: readOnlyAnnotations,
  },
  {
    name: "get",
    title: "QMD-compatible document get alias",
    description: "Compatibility alias for oms_get_document backed by the native OMS semantic index.",
    inputSchema: getDocumentInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "multi_get",
    title: "QMD-compatible document multi-get alias",
    description: "Compatibility alias for oms_multi_get_documents backed by the native OMS semantic index.",
    inputSchema: multiGetInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "oms_multi_get_documents",
    title: "Oh My Second Brain multi-get documents",
    description: "Read multiple selected semantic paths, globs, or docids in one batch without writing to the vault.",
    inputSchema: multiGetInputSchema,
    annotations: readOnlyAnnotations,
  },
];
