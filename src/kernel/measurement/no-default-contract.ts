import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  embeddingModelCacheDir,
  EMBEDDING_MODEL_ENV,
  EMBEDDING_PROVIDER_ENV,
  INSTALLED_MODELS_RECEIPT,
  resolveEmbeddingModel,
} from "../engine/embed/model.js";
import { assembleCoreSemanticEngine } from "../engine/assemble.js";

export interface NoDefaultContract {
  readonly resolveEmbeddingModel: typeof resolveEmbeddingModel;
  readonly installedReceiptExists: () => boolean | Promise<boolean>;
  readonly runMcp: (options: {
    readonly fetch: typeof globalThis.fetch;
    readonly waiverActive: boolean;
  }) => unknown | Promise<unknown>;
  readonly fetch: typeof globalThis.fetch;
}

/** Note seeded into the disposable probe vault so lexical retrieval has a hit. */
const PROBE_NOTE = "probe.md";
const PROBE_TERM = "ataraxia";

/**
 * Exercise the real MCP surface with no embedding model configured.
 *
 * The probe must press the paths that actually depend on a model, otherwise it
 * proves nothing: a document read never needed one. So it asserts both halves
 * of the lex-only contract - a plain query still succeeds lexically, and an
 * explicit vector or HyDE request is refused loudly while naming both canonical
 * environment variables. The counted `fetch` is installed globally for the
 * duration so any network attempt on these paths is observed by the verifier.
 */
async function probeNoModelMcp(countedFetch: typeof globalThis.fetch): Promise<void> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-no-default-mcp-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = countedFetch;
  const engine = assembleCoreSemanticEngine({ vault });
  try {
    await writeFile(
      path.join(vault, PROBE_NOTE),
      `# Probe\n\nThis note mentions ${PROBE_TERM} exactly once.\n`,
      "utf-8",
    );

    // (1) Plain lexical retrieval must remain available without a model.
    const lexical = await engine.adapter.semanticQuery({
      searches: [{ type: "lex", query: PROBE_TERM }],
    });
    if (lexical.available !== true) {
      throw new Error(
        "no-model MCP probe: plain lexical query must stay available without an embedding model, " +
          `got unavailable (${"reason" in lexical ? String(lexical.reason) : "no reason"})`,
      );
    }
    if (!lexical.hits.some((hit) => hit.path === PROBE_NOTE)) {
      throw new Error("no-model MCP probe: plain lexical query did not retrieve the seeded note");
    }

    // (2) Explicit model-dependent channels must fail loudly, naming both vars.
    for (const type of ["vec", "hyde"] as const) {
      let refusal = "";
      try {
        const result = await engine.adapter.semanticQuery({
          searches: [{ type, query: PROBE_TERM }],
        });
        refusal = result.available === true
          ? ""
          : "reason" in result ? String(result.reason) : "";
        if (result.available === true) {
          throw new Error(
            `no-model MCP probe: explicit ${type} must not report available without a model`,
          );
        }
      } catch (error) {
        if (refusal === "") refusal = error instanceof Error ? error.message : String(error);
      }
      if (!refusal.includes(EMBEDDING_PROVIDER_ENV) || !refusal.includes(EMBEDDING_MODEL_ENV)) {
        throw new Error(
          `no-model MCP probe: explicit ${type} refusal must name ${EMBEDDING_PROVIDER_ENV} and ` +
            `${EMBEDDING_MODEL_ENV}, got: ${refusal}`,
        );
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    await engine.dispose();
    await rm(vault, { recursive: true, force: true });
  }
}

/**
 * Production probes for the E-1 no-default contract. The MCP exercise uses a
 * disposable vault so release checks never create files in a user vault.
 */
export function createNoDefaultContract(options: {
  readonly cacheDir?: string;
} = {}): NoDefaultContract {
  const cacheDir = embeddingModelCacheDir({ cacheDir: options.cacheDir });
  return {
    resolveEmbeddingModel: (resolveOptions = {}) => resolveEmbeddingModel({
      ...resolveOptions,
      cacheDir,
    }),
    installedReceiptExists: () => existsSync(path.join(cacheDir, INSTALLED_MODELS_RECEIPT)),
    runMcp: async ({ fetch }) => probeNoModelMcp(fetch),
    fetch: globalThis.fetch.bind(globalThis),
  };
}
