import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import type { McpEngineAdapter } from "../kernel/engine/mcp/facade.js";
import type {
  SemanticQueryOptions,
  SemanticSearchMode,
  SemanticTypedSearch,
} from "../kernel/search/semantic-contract.js";
import type { McpSemanticExpandStrategy } from "../kernel/engine/mcp/types.js";
import { createEngineSession } from "./engine-session.js";

export interface ServeHttpServer {
  readonly url: string;
  close(): Promise<void>;
}

export interface ServeHttpOptions {
  readonly vault: string;
  readonly index?: string;
  readonly host?: string;
  readonly port?: number;
  /** Caller-owned adapter seam. When supplied, the server never disposes it. */
  readonly adapter?: McpEngineAdapter;
  /** Test/embedding seam; production omission uses the standard user cache. */
  readonly modelCacheDir?: string;
  /** Test seam: prevents ambient model environment from changing server behavior. */
  readonly modelEnv?: Readonly<Record<string, string | undefined>>;
}

interface RouteContext {
  readonly vault: string;
  readonly index?: string;
  readonly adapter?: McpEngineAdapter;
  readonly modelCacheDir?: string;
  readonly modelEnv?: Readonly<Record<string, string | undefined>>;
}

const HTTP_METHODS: Readonly<Record<string, string>> = {
  "/health": "GET",
  "/search": "POST",
  "/get": "POST",
  "/multi-get": "POST",
};

function safeHost(host: string | undefined): string {
  const selected = host?.trim() || "127.0.0.1";
  if (selected !== "127.0.0.1" && selected !== "localhost" && selected !== "::1") {
    throw new Error("OMS search HTTP server only binds to localhost without authentication.");
  }
  return selected;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class HttpInputError extends Error {}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpInputError("Request body must be a JSON object.");
  return value;
}

function onlyFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new HttpInputError(`Unknown request field: ${unknown}.`);
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  required = false,
): string | undefined {
  const field = value[key];
  if (field === undefined) {
    if (required) throw new HttpInputError(`Field "${key}" is required.`);
    return undefined;
  }
  if (typeof field !== "string" || (required && field.length === 0)) {
    throw new HttpInputError(`Field "${key}" must be ${required ? "a non-empty " : "a "}string.`);
  }
  return field;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new HttpInputError(`Field "${key}" must be a finite number.`);
  }
  return field;
}

function booleanField(value: Record<string, unknown>, key: string): boolean | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "boolean") throw new HttpInputError(`Field "${key}" must be a boolean.`);
  return field;
}

function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  if (!Array.isArray(field) || field.length === 0 ||
    !field.every((item) => typeof item === "string" && item.length > 0)) {
    throw new HttpInputError(`Field "${key}" must be a non-empty array of non-empty strings.`);
  }
  return field;
}

const SEARCH_FIELDS = new Set([
  "query", "strategy", "searches", "collection", "limit", "minScore", "intent",
  "candidateLimit", "rerank", "lex", "vec", "hyde",
]);
const GET_FIELDS = new Set([
  "target", "collection", "fromLine", "lineCount", "lineNumbers", "fullPath",
]);
const MULTI_GET_FIELDS = new Set([
  "targets", "collection", "lineLimit", "maxBytes", "lineNumbers", "fullPath",
]);

function strategyField(record: Record<string, unknown>): McpSemanticExpandStrategy | undefined {
  const strategy = record["strategy"];
  if (strategy === undefined) return undefined;
  if (!isRecord(strategy)) throw new HttpInputError('Field "strategy" must be an object.');
  onlyFields(strategy, new Set(["kind", "profile", "maxQueries"]));
  if (strategy["kind"] !== "expand" || strategy["profile"] !== "qmd-v2.8.3") {
    throw new HttpInputError('Field "strategy" requires kind "expand" and profile "qmd-v2.8.3".');
  }
  const maxQueries = numberField(strategy, "maxQueries");
  if (maxQueries !== undefined && (!Number.isInteger(maxQueries) || maxQueries <= 0)) {
    throw new HttpInputError('Field "strategy.maxQueries" must be a positive integer.');
  }
  return { kind: "expand", profile: "qmd-v2.8.3", ...(maxQueries === undefined ? {} : { maxQueries }) };
}

function searchesField(record: Record<string, unknown>): readonly SemanticTypedSearch[] | undefined {
  const searches = record["searches"];
  if (searches === undefined) return undefined;
  if (!Array.isArray(searches) || searches.length === 0) {
    throw new HttpInputError('Field "searches" must be a non-empty array.');
  }
  return searches.map((entry, index) => {
    if (!isRecord(entry)) throw new HttpInputError(`Field "searches[${index}]" must be an object.`);
    onlyFields(entry, new Set(["type", "query"]));
    if (entry["type"] !== "lex" && entry["type"] !== "vec" && entry["type"] !== "hyde") {
      throw new HttpInputError(`Field "searches[${index}].type" must be lex, vec, or hyde.`);
    }
    const query = stringField(entry, "query", true)!;
    return { type: entry["type"], query };
  });
}

function queryOptions(ctx: RouteContext, mode: SemanticSearchMode, body: unknown): SemanticQueryOptions {
  const record = bodyRecord(body);
  onlyFields(record, SEARCH_FIELDS);
  const query = stringField(record, "query");
  const searches = searchesField(record);
  const lex = stringField(record, "lex");
  const vec = stringField(record, "vec");
  const hyde = stringField(record, "hyde");
  if (query === undefined && searches === undefined && lex === undefined && vec === undefined && hyde === undefined) {
    throw new HttpInputError('Search requires one of "query", "searches", "lex", "vec", or "hyde".');
  }
  if (query !== undefined && searches !== undefined) {
    throw new HttpInputError('Fields "query" and "searches" are mutually exclusive.');
  }
  return {
    vault: ctx.vault,
    index: ctx.index,
    mode,
    query,
    strategy: strategyField(record),
    searches,
    collection: stringField(record, "collection"),
    limit: numberField(record, "limit"),
    minScore: numberField(record, "minScore"),
    intent: stringField(record, "intent"),
    candidateLimit: numberField(record, "candidateLimit"),
    rerank: booleanField(record, "rerank"),
    lex,
    vec,
    hyde,
  };
}

async function withRequestAdapter<T>(
  ctx: RouteContext,
  operation: (adapter: McpEngineAdapter) => Promise<T>,
): Promise<T> {
  if (ctx.adapter !== undefined) return operation(ctx.adapter);
  const session = createEngineSession(ctx.vault, {
    write: false,
    modelCacheDir: ctx.modelCacheDir,
    modelEnv: ctx.modelEnv,
  });
  try {
    return await operation(session.adapter);
  } finally {
    await session.dispose();
  }
}

async function routeRequest(ctx: RouteContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const pathName = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const allowedMethod = HTTP_METHODS[pathName];
  if (allowedMethod !== undefined && request.method !== allowedMethod) {
    response.setHeader("allow", allowedMethod);
    sendJson(response, 405, { ok: false, reason: "Method not allowed." });
    return;
  }
  if (allowedMethod === undefined) {
    sendJson(response, 404, { ok: false, reason: "Unknown OMS search HTTP endpoint." });
    return;
  }

  try {
    if (request.method === "GET" && pathName === "/health") {
      const status = await withRequestAdapter(
        ctx,
        (adapter) => adapter.semanticStatus({ vault: ctx.vault, index: ctx.index }),
      );
      sendJson(response, 200, {
        ok: status.available,
        storage: status.available ? status.storage : "oms-native-json",
        status,
      });
      return;
    }
    if (request.method === "POST" && pathName === "/search") {
      const body = await readJsonBody(request);
      const options = queryOptions(ctx, "search", body);
      sendJson(response, 200, await withRequestAdapter(
        ctx,
        (adapter) => adapter.semanticQuery(options),
      ));
      return;
    }
    if (request.method === "POST" && pathName === "/get") {
      const body = await readJsonBody(request);
      const record = bodyRecord(body);
      onlyFields(record, GET_FIELDS);
      const options = {
        vault: ctx.vault,
        target: stringField(record, "target", true)!,
        collection: stringField(record, "collection"),
        fromLine: numberField(record, "fromLine"),
        lineCount: numberField(record, "lineCount"),
        lineNumbers: booleanField(record, "lineNumbers"),
        fullPath: booleanField(record, "fullPath"),
      };
      sendJson(response, 200, await withRequestAdapter(
        ctx,
        (adapter) => adapter.getDocument(options),
      ));
      return;
    }
    if (request.method === "POST" && pathName === "/multi-get") {
      const body = await readJsonBody(request);
      const record = bodyRecord(body);
      onlyFields(record, MULTI_GET_FIELDS);
      const options = {
        vault: ctx.vault,
        targets: stringArrayField(record, "targets"),
        collection: stringField(record, "collection"),
        lineLimit: numberField(record, "lineLimit"),
        maxBytes: numberField(record, "maxBytes"),
        lineNumbers: booleanField(record, "lineNumbers"),
        fullPath: booleanField(record, "fullPath"),
      };
      sendJson(response, 200, await withRequestAdapter(
        ctx,
        (adapter) => adapter.multiGetDocuments(options),
      ));
      return;
    }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    sendJson(response, error instanceof HttpInputError || error instanceof SyntaxError ? 400 : 500, {
      ok: false,
      reason: detail,
    });
  }
}

export async function runServeHttp(opts: ServeHttpOptions): Promise<ServeHttpServer> {
  const host = safeHost(opts.host);
  const port = opts.port ?? 8765;
  // Verify the normal engine path before listening, then release its immutable
  // snapshot. Each request acquires a fresh read-only snapshot so external index
  // syncs become visible without sharing or disposing another request's engine.
  if (opts.adapter === undefined) {
    const readiness = createEngineSession(opts.vault, {
      write: false,
      modelCacheDir: opts.modelCacheDir,
      modelEnv: opts.modelEnv,
    });
    await readiness.dispose();
  }
  const ctx: RouteContext = {
    vault: opts.vault,
    index: opts.index,
    adapter: opts.adapter,
    modelCacheDir: opts.modelCacheDir,
    modelEnv: opts.modelEnv,
  };
  const server: Server = createServer((request, response) => {
    void routeRequest(ctx, request, response);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    throw error;
  }
  const address = server.address();
  const actualPort = typeof address === "object" && address ? (address as AddressInfo).port : port;
  const urlHost = host === "::1" ? "[::1]" : host;
  return {
    url: `http://${urlHost}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
