const typedQuerySearchSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["lex", "vec", "hyde"] },
    query: { type: "string" },
  },
  required: ["type", "query"],
} as const;


export const retrieveContextSemanticInputProperties = {
  semanticEnabled: { type: "boolean" },
  semanticCollection: { type: "string" },
  semanticLimit: { type: "integer", minimum: 0 },
  semanticScope: { type: "string", enum: ["global", "graph"] },
  semanticMode: { type: "string", enum: ["query", "search", "vsearch"] },
  semanticIntent: { type: "string" },

  semanticSearches: { type: "array", items: typedQuerySearchSchema },
  semanticLex: { type: "string" },
  semanticVec: { type: "string" },
  semanticHyde: { type: "string" },
  semanticMinScore: { type: "number" },
  semanticAll: { type: "boolean" },
  semanticFormat: { type: "string", enum: ["json", "files"] },
  semanticFull: { type: "boolean" },
  semanticLineNumbers: { type: "boolean" },
  semanticFullPath: { type: "boolean" },
  semanticIndex: { type: "string" },
  semanticChunkStrategy: { type: "string" },
  semanticCandidateLimit: { type: "integer", minimum: 1 },
  semanticNoRerank: { type: "boolean" },
  semanticHydrate: { type: "string", enum: ["none", "top", "all", "targets"] },
  semanticHydrateTargets: { type: "array", items: { type: "string" } },
  semanticHydrateLineLimit: { type: "number" },
  semanticHydrateMaxBytes: { type: "number" },
  semanticHydrateFromLine: { type: "number" },
  semanticHydrateLineCount: { type: "number" },
} as const;
