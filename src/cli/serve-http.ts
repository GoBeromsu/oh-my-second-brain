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
  /** Test/embedding seam; production omission uses the standard user cache. */
  readonly modelCacheDir?: string;
  /** Test seam: prevents ambient model environment from changing server behavior. */
  readonly modelEnv?: Readonly<Record<string, string | undefined>>;
}

interface RouteContext {
  readonly vault: string;
  readonly index?: string;
  readonly adapter: McpEngineAdapter;
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

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" ? field : undefined;
}

function booleanField(value: Record<string, unknown>, key: string): boolean | undefined {
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}

function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  return Array.isArray(field) && field.every((item) => typeof item === "string") ? field : [];
}

function queryOptions(ctx: RouteContext, mode: SemanticSearchMode, body: unknown): SemanticQueryOptions {
  const record = isRecord(body) ? body : {};
  return {
    vault: ctx.vault,
    index: ctx.index,
    mode,
    query: stringField(record, "query") ?? "",
    strategy: record["strategy"] as McpSemanticExpandStrategy | undefined,
    searches: record["searches"] as readonly SemanticTypedSearch[] | undefined,
    collection: stringField(record, "collection"),
    limit: numberField(record, "limit"),
    minScore: numberField(record, "minScore"),
    intent: stringField(record, "intent"),
    candidateLimit: numberField(record, "candidateLimit"),
    rerank: booleanField(record, "rerank"),
    lex: stringField(record, "lex"),
    vec: stringField(record, "vec"),
    hyde: stringField(record, "hyde"),
  };
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
      const status = await ctx.adapter.semanticStatus({ vault: ctx.vault, index: ctx.index });
      sendJson(response, 200, {
        ok: status.available,
        storage: status.available ? status.storage : "oms-native-json",
        status,
      });
      return;
    }
    if (request.method === "POST" && pathName === "/search") {
      const body = await readJsonBody(request);
      sendJson(response, 200, await ctx.adapter.semanticQuery(queryOptions(ctx, "search", body)));
      return;
    }
    if (request.method === "POST" && pathName === "/get") {
      const body = await readJsonBody(request);
      const record = isRecord(body) ? body : {};
      sendJson(response, 200, await ctx.adapter.getDocument({
        vault: ctx.vault,
        target: stringField(record, "target") ?? "",
        collection: stringField(record, "collection"),
        fromLine: numberField(record, "fromLine"),
        lineCount: numberField(record, "lineCount"),
        lineNumbers: booleanField(record, "lineNumbers"),
        fullPath: booleanField(record, "fullPath"),
      }));
      return;
    }
    if (request.method === "POST" && pathName === "/multi-get") {
      const body = await readJsonBody(request);
      const record = isRecord(body) ? body : {};
      sendJson(response, 200, await ctx.adapter.multiGetDocuments({
        vault: ctx.vault,
        targets: stringArrayField(record, "targets"),
        collection: stringField(record, "collection"),
        lineLimit: numberField(record, "lineLimit"),
        maxBytes: numberField(record, "maxBytes"),
        lineNumbers: booleanField(record, "lineNumbers"),
        fullPath: booleanField(record, "fullPath"),
      }));
      return;
    }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, { ok: false, reason: detail });
  }
}

export async function runServeHttp(opts: ServeHttpOptions): Promise<ServeHttpServer> {
  const host = safeHost(opts.host);
  const port = opts.port ?? 8765;
  // Single engine per server: vec-capable when configured, else lexical and
  // document operations remain available while vector and HyDE requests fail loud.
  const session = createEngineSession(opts.vault, {
    write: true,
    modelCacheDir: opts.modelCacheDir,
    modelEnv: opts.modelEnv,
  });
  const ctx: RouteContext = { vault: opts.vault, index: opts.index, adapter: session.adapter };
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
    await session.dispose().catch(() => undefined);
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
          void session.dispose().catch(() => undefined);
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
