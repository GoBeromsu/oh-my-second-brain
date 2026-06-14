import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import {
  cleanupSemanticStore,
  listSemanticCollections,
  listSemanticContexts,
  querySemanticStore,
  readSemanticStatus,
} from "../search/semantic.js";
import type { SemanticQueryOptions, SemanticSearchMode } from "../search/semantic.js";
import type { SemanticStorage } from "../search/semantic.js";
import { handleSemanticTool } from "../mcp/semantic-retrieve.js";
import { semanticMcpTools } from "../mcp/semantic-schemas.js";

export interface SemanticHttpServer {
  readonly url: string;
  close(): Promise<void>;
}

export interface SemanticHttpServerOptions {
  readonly vault: string;
  readonly index?: string;
  readonly storage?: SemanticStorage;
  readonly modelPath?: string;
  readonly host?: string;
  readonly port?: number;
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

function storageField(value: Record<string, unknown>, key: string): SemanticStorage | undefined {
  const field = stringField(value, key);
  return field === "qmd-sqlite" || field === "oms-native-json" ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" ? field : undefined;
}

function queryOptions(
  opts: Required<Pick<SemanticHttpServerOptions, "vault">> & Pick<SemanticHttpServerOptions, "index" | "storage" | "modelPath">,
  mode: SemanticSearchMode,
  body: unknown,
): SemanticQueryOptions {
  const record = isRecord(body) ? body : {};
  return {
    vault: opts.vault,
    index: opts.index,
    storage: storageField(record, "storage") ?? opts.storage,
    modelPath: stringField(record, "modelPath") ?? opts.modelPath,
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

async function handleMcpJsonRpc(
  opts: Required<Pick<SemanticHttpServerOptions, "vault">> & Pick<SemanticHttpServerOptions, "index" | "storage" | "modelPath">,
  body: unknown,
): Promise<unknown> {
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
      ? {
          ...params["arguments"],
          index: stringField(params["arguments"], "index") ?? opts.index,
          storage: storageField(params["arguments"], "storage") ?? opts.storage,
          modelPath: stringField(params["arguments"], "modelPath") ?? opts.modelPath,
        }
      : { index: opts.index, storage: opts.storage, modelPath: opts.modelPath };
    if (!name) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Missing tool name." } };
    const result = await handleSemanticTool(name, args, opts.vault);
    if (!result) return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown OMS semantic tool: ${name}` } };
    return result.ok
      ? { jsonrpc: "2.0", id, result: result.value }
      : { jsonrpc: "2.0", id, error: { code: -32602, message: result.message } };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported OMS semantic MCP method: ${method ?? ""}` } };
}

async function routeRequest(
  opts: Required<Pick<SemanticHttpServerOptions, "vault">> & Pick<SemanticHttpServerOptions, "index" | "storage" | "modelPath">,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const pathName = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  try {
    if (request.method === "GET" && pathName === "/health") {
      const status = await readSemanticStatus({
        vault: opts.vault,
        index: opts.index,
        storage: opts.storage,
        modelPath: opts.modelPath,
      });
      sendJson(response, 200, {
        ok: status.available,
        storage: status.available ? status.storage : opts.storage ?? "qmd-sqlite",
        status,
      });
      return;
    }
    if (request.method === "POST" && (pathName === "/query" || pathName === "/search")) {
      const body = await readJsonBody(request);
      const mode = pathName === "/search" ? "search" : "query";
      sendJson(response, 200, await querySemanticStore(queryOptions(opts, mode, body)));
      return;
    }
    if (request.method === "POST" && pathName === "/mcp") {
      sendJson(response, 200, await handleMcpJsonRpc(opts, await readJsonBody(request)));
      return;
    }
    if (request.method === "GET" && pathName === "/collections") {
      sendJson(response, 200, await listSemanticCollections({ vault: opts.vault, index: opts.index, storage: opts.storage }));
      return;
    }
    if (request.method === "GET" && pathName === "/contexts") {
      sendJson(response, 200, await listSemanticContexts({ vault: opts.vault, index: opts.index, storage: opts.storage }));
      return;
    }
    if (request.method === "POST" && pathName === "/cleanup") {
      sendJson(response, 200, await cleanupSemanticStore({ vault: opts.vault, index: opts.index, storage: opts.storage }));
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
  const server: Server = createServer((request, response) => {
    void routeRequest({
      vault: opts.vault,
      index: opts.index,
      storage: opts.storage,
      modelPath: opts.modelPath,
    }, request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? (address as AddressInfo).port : port;
  const urlHost = host === "::1" ? "[::1]" : host;
  return {
    url: `http://${urlHost}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
