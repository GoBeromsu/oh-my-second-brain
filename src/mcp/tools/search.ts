import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { deriveTemplateRetrievalAxes } from "../../kernel/engine/retrieval/axes.js";
import { readSearchTemplateSource } from "../../kernel/engine/retrieval/template-source.js";
import { readBundledPackageVersion } from "../../kernel/runtime/assets.js";
import { appendRuntimeEvent, createRuntimeEvent, createRuntimeInvocation } from "../../kernel/runtime/event-journal.js";
import { retrieveMorningContext } from "../../kernel/search/morning.js";
import { readExactDocument } from "../../kernel/search/read-exact.js";
import {
  handleSemanticTool,
  isEngineSemanticOp,
  isEngineDocumentOp,
  isModelOptionalSemanticQueryOp,
  semanticOptionsFromArgs,
} from "../../kernel/semantic/semantic-retrieve.js";
import { semanticQueryOptionsFromArgs } from "../../kernel/semantic/semantic-retrieve-args.js";
import { EngineSearchBackend } from "../../kernel/searchbackend/engine-search-backend.js";
import { makeEngineMorningBackend } from "../engine-morning-backend.js";
import { runtimeHistory } from "./status.js";
import { errorText, isRecord, jsonText, SemanticIndexUnavailableError, stringArg, type ToolContext } from "./shared.js";

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

/** `search {path}`: the engine-free exact read. Returns undefined when `path` is absent. */
export async function searchExactRead(vault: string, args: Record<string, unknown> | undefined): Promise<CallToolResult | undefined> {
  if (args === undefined || !("path" in args)) return undefined;
  if (Object.keys(args).some((key) => key !== "path")) {
    return errorText('SEARCH_ARGS_INVALID: "path" is mutually exclusive with "op" and every other search argument.');
  }
  const notePath = args["path"];
  if (typeof notePath !== "string") return errorText('SEARCH_ARGS_INVALID: "path" must be a vault-relative string.');
  try {
    return jsonText(await readExactDocument(vault, notePath));
  } catch (error) {
    // readExactDocument already reports path errors as a result; anything left is I/O.
    return errorText(`Oh My Second Brain MCP error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** MCP `search`: argument checks and rewrites that precede dispatch; returns an error result or the effective call. */
export function prepareSearch(
  name: string,
  op: string | undefined,
  args: Record<string, unknown> | undefined,
): CallToolResult | { readonly name: string; readonly args: Record<string, unknown> | undefined } {
  if (op === "query") {
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
  return { name, args };
}

/** MCP `search`: templates, context, semantic, and document reads. Returns undefined for an operation it does not own. */
export async function handleSearch(ctx: ToolContext, publicName: string, name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult | undefined> {
  const {
    vault,
    engine,
    getReadOnlySemanticEngine,
    getReadOnlyCoreSemanticEngine,
    getSemanticEngine,
    hasEmbeddingModel,
    resolveDocumentAdapter,
    resolveReadOnlyIndexAdapter,
    resolveReadOnlyLexicalAdapter,
    hasExplicitEmbeddingIntent,
    searchBackend,
  } = ctx;
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
  return undefined;
}
