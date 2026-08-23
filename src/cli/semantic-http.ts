import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import type { McpEngineAdapter } from "../kernel/engine/mcp/facade.js";
import { assembleSemanticEngine } from "../kernel/semantic/semantic-engine.js";
import type { SemanticQueryOptions, SemanticSearchMode } from "../kernel/search/semantic-contract.js";
import { handleSemanticTool } from "../kernel/semantic/semantic-retrieve.js";
import { semanticMcpTools } from "../kernel/semantic/semantic-schemas.js";

export interface SemanticHttpServer {
  readonly url: string;
  close(): Promise<void>;
}

export interface SemanticHttpServerOptions {
  readonly vault: string;
  readonly index?: string;
  readonly host?: string;
  readonly port?: number;
}

interface RouteContext {
  readonly vault: string;
  readonly index?: string;
  readonly adapter: McpEngineAdapter;
}

function safeHost(host: string | undefined): string {
  const selected = host?.trim() || "127.0.0.1";
  if (selected !== "127.0.0.1" && selected !== "localhost" && selected !== "::1") {
    throw new Error("OMS semantic HTTP server only binds to localhost without authentication.");
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

function queryOptions(ctx: RouteContext, mode: SemanticSearchMode, body: unknown): SemanticQueryOptions {
  const record = isRecord(body) ? body : {};
  return {
    vault: ctx.vault,
    index: ctx.index,
    mode,
    query: stringField(record, "query") ?? "",
    collection: stringField(record, "collection"),
    limit: numberField(record, "limit"),
    minScore: numberField(record, "minScore"),
    intent: stringField(record, "intent"),
    lex: stringField(record, "lex"),
    vec: stringField(record, "vec"),
    hyde: stringField(record, "hyde"),
  };
}

async function handleMcpJsonRpc(ctx: RouteContext, body: unknown): Promise<unknown> {
  if (!isRecord(body)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } };
  const id = body["id"] ?? null;
  const method = stringField(body, "method");
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: semanticMcpTools } };
  }
  if (method === "tools/call" && isRecord(body["params"])) {
    const params = body["params"];
    const name = stringField(params, "name");
    const args = isRecord(params["arguments"])
      ? { ...params["arguments"], index: stringField(params["arguments"], "index") ?? ctx.index }
      : { index: ctx.index };
    if (!name) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Missing tool name." } };
    const result = await handleSemanticTool(name, args, ctx.vault, ctx.adapter);
    if (!result) return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown OMS semantic tool: ${name}` } };
    return result.ok
      ? { jsonrpc: "2.0", id, result: result.value }
      : { jsonrpc: "2.0", id, error: { code: -32602, message: result.message } };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported OMS semantic MCP method: ${method ?? ""}` } };
}

async function routeRequest(ctx: RouteContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const pathName = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  try {
    if (request.method === "GET" && pathName === "/health") {
      const status = ctx.adapter.semanticStatus({ vault: ctx.vault, index: ctx.index });
      sendJson(response, 200, {
        ok: status.available,
        storage: status.available ? status.storage : "oms-native-json",
        status,
      });
      return;
    }
    if (request.method === "POST" && (pathName === "/query" || pathName === "/search")) {
      const body = await readJsonBody(request);
      const mode = pathName === "/search" ? "search" : "query";
      sendJson(response, 200, await ctx.adapter.semanticQuery(queryOptions(ctx, mode, body)));
      return;
    }
    if (request.method === "POST" && pathName === "/mcp") {
      sendJson(response, 200, await handleMcpJsonRpc(ctx, await readJsonBody(request)));
      return;
    }
    if (request.method === "GET" && pathName === "/collections") {
      sendJson(response, 200, ctx.adapter.listCollections({ vault: ctx.vault, index: ctx.index }));
      return;
    }
    if (request.method === "GET" && pathName === "/contexts") {
      sendJson(response, 200, ctx.adapter.listContexts({ vault: ctx.vault, index: ctx.index }));
      return;
    }
    if (request.method === "POST" && pathName === "/cleanup") {
      sendJson(response, 200, await ctx.adapter.cleanup({ vault: ctx.vault, index: ctx.index }));
      return;
    }
    sendJson(response, 404, { ok: false, reason: "Unknown OMS semantic HTTP endpoint." });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, { ok: false, reason: detail });
  }
}

export async function startSemanticHttpServer(opts: SemanticHttpServerOptions): Promise<SemanticHttpServer> {
  const host = safeHost(opts.host);
  const port = opts.port ?? 8765;
  // Single engine per server: vec-capable when OMS_EMBEDDING_PROVIDER/MODEL are
  // configured, else a core lex + document engine (vec/HyDE fail fast).
  const engine = assembleSemanticEngine(opts.vault);
  const ctx: RouteContext = { vault: opts.vault, index: opts.index, adapter: engine.adapter };
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
    await engine.dispose().catch(() => undefined);
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
          void engine.dispose().catch(() => undefined);
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
