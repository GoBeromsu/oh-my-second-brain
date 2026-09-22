import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeMorningVaultFixture } from "../kernel/search/morning-test-fixtures.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");

type ProbeOptions = {
  readonly vault: string;
  readonly env: Record<string, string>;
  readonly loadRequest?: Record<string, unknown>;
  readonly queryRequest?: Record<string, unknown>;
  readonly timeoutMs?: number;
};

type ProbeResult = {
  readonly frames: readonly unknown[];
  readonly invalidStdoutLines: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

function frameId(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "number" ? id : undefined;
}

function isJsonRpcFrame(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Record<string, unknown>;
  return frame.jsonrpc === "2.0" && (frame.id !== undefined || typeof frame.method === "string");
}

/**
 * Drive the real CLI process one response at a time. Sending the embedding
 * request only after tools/list has completed keeps this probe on the same
 * cold-start path an MCP client uses, while still letting it inspect every byte
 * written to stdout rather than relying on the SDK's parser.
 */
async function runStdioProbe(options: ProbeOptions): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const child = spawn(
      process.execPath,
      [distCli, "serve", "mcp", "--vault", options.vault],
      {
        cwd: repoRoot,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let pendingStdout = "";
    let timedOut = false;
    let finishing = false;
    const frames: unknown[] = [];
    const invalidStdoutLines: string[] = [];
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? 30_000);

    const send = (value: Record<string, unknown>): void => {
      if (finishing || child.stdin.destroyed) return;
      child.stdin.write(`${JSON.stringify(value)}\n`);
    };

    const finish = (): void => {
      if (finishing) return;
      finishing = true;
      child.stdin.end();
      child.kill("SIGTERM");
    };

    const consumeStdout = (chunk: string): void => {
      pendingStdout += chunk;
      for (;;) {
        const newline = pendingStdout.indexOf("\n");
        if (newline < 0) return;
        const line = pendingStdout.slice(0, newline).trim();
        pendingStdout = pendingStdout.slice(newline + 1);
        try {
          const frame: unknown = JSON.parse(line);
          frames.push(frame);
          const id = frameId(frame);
          if (id === 1) {
            send({
              jsonrpc: "2.0",
              method: "notifications/initialized",
              params: {},
            });
            send({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/list",
              params: {},
            });
          } else if (id === 2 && options.loadRequest !== undefined) {
            send(options.loadRequest);
          } else if (id === 3 && options.queryRequest !== undefined) {
            send(options.queryRequest);
          } else if (
            (id === 2 && options.loadRequest === undefined) ||
            (id === 3 && options.queryRequest === undefined) ||
            id === 4
          ) {
            finish();
          }
        } catch {
          invalidStdoutLines.push(line);
        }
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      consumeStdout(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: Error) => {
      stderr += `${error.message}\n`;
      finish();
    });
    child.on("close", () => {
      clearTimeout(timeout);
      const tail = pendingStdout.trim();
      if (tail !== "") {
        try {
          frames.push(JSON.parse(tail));
        } catch {
          invalidStdoutLines.push(tail);
        }
      }
      resolve({ frames, invalidStdoutLines, stdout, stderr, timedOut });
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "oms-stdio-framing-test", version: "0.0.0" },
      },
    });
  });
}

function assertCleanProtocolOutput(probe: ProbeResult): void {
  expect(probe.timedOut).toBe(false);
  expect(probe.invalidStdoutLines).toEqual([]);
  expect(probe.frames.length).toBeGreaterThan(0);
  expect(probe.frames.every(isJsonRpcFrame)).toBe(true);
}

/** The raw JSON-RPC result of one frame, for methods that do not return tool content. */
function frameResult(probe: ProbeResult, id: number): Record<string, unknown> {
  const frame = probe.frames.find((candidate) => frameId(candidate) === id);
  expect(frame).toBeDefined();
  const result = (frame as Record<string, unknown>).result;
  expect(result).toBeDefined();
  return result as Record<string, unknown>;
}

function toolPayload(probe: ProbeResult, id: number): Record<string, unknown> {
  const frame = probe.frames.find((candidate) => frameId(candidate) === id);
  expect(frame).toBeDefined();
  const result = (frame as Record<string, unknown>).result;
  expect(result).toBeDefined();
  const content = (result as Record<string, unknown>).content;
  expect(Array.isArray(content)).toBe(true);
  const text = (content as Array<Record<string, unknown>>)[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text as string) as Record<string, unknown>;
}

function installedModelId(modelPath: string): string | undefined {
  const cacheRoot = process.env["XDG_CACHE_HOME"]?.trim() ||
    path.join(process.env["HOME"]?.trim() || os.homedir(), ".cache");
  const receiptPath = path.join(cacheRoot, "oms", "models", "installed-models.json");
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      readonly artifacts?: readonly {
        readonly path?: unknown;
        readonly selection?: { readonly model?: unknown };
      }[];
    };
    const artifact = receipt.artifacts?.find(
      (candidate) =>
        typeof candidate.path === "string" &&
        path.resolve(candidate.path) === path.resolve(modelPath),
    );
    return typeof artifact?.selection?.model === "string"
      ? artifact.selection.model
      : undefined;
  } catch {
    return undefined;
  }
}

describe("MCP stdio framing", () => {
  it("keeps a model-free cold start's stdout to JSON-RPC frames", async () => {
    const vault = await writeMorningVaultFixture();
    try {
      const probe = await runStdioProbe({
        vault,
        env: { ...getDefaultEnvironment(), HOME: vault },
      });
      assertCleanProtocolOutput(probe);
      const tools = frameResult(probe, 2).tools as { readonly name: string }[];
      expect(tools.map(tool => tool.name)).toEqual(["write", "search", "link", "status", "doctor"]);
    } finally {
      await import("node:fs/promises").then(({ rm }) => rm(vault, { recursive: true, force: true }));
    }
  });
});

// This is deliberately separate from the hermetic framing proof. It requires an
// operator-provided, installed GGUF artifact and therefore must never fake model
// existence or a successful embedding result on machines without native assets.
const operatorModelPath = process.env["OMS_MODEL_PATH"]?.trim();
const operatorModelId =
  process.env["OMS_EMBEDDING_MODEL"]?.trim() ||
  (operatorModelPath === undefined ? undefined : installedModelId(operatorModelPath));
const nativeProbeEnabled =
  operatorModelPath !== undefined &&
  existsSync(operatorModelPath) &&
  operatorModelId !== undefined &&
  operatorModelId.length > 0;

describe.skipIf(!nativeProbeEnabled)(
  "MCP stdio framing — operator native GGUF proof",
  () => {
    it(
      "keeps cold model load and vector search diagnostics off stdout",
      async () => {
        const vault = await writeMorningVaultFixture();
        try {
          const probe = await runStdioProbe({
            vault,
            timeoutMs: 120_000,
            env: {
              ...getDefaultEnvironment(),
              ...(process.env["XDG_CACHE_HOME"] === undefined
                ? {}
                : { XDG_CACHE_HOME: process.env["XDG_CACHE_HOME"] }),
              OMS_EMBEDDING_PROVIDER: "gguf",
              OMS_EMBEDDING_MODEL: operatorModelId!,
            },
            loadRequest: {
              jsonrpc: "2.0",
              id: 3,
              method: "tools/call",
              params: {
                name: "doctor",
                arguments: { op: "sync-embeddings", mode: "embed" },
              },
            },
            queryRequest: {
              jsonrpc: "2.0",
              id: 4,
              method: "tools/call",
              params: {
                name: "search",
                arguments: {
                  op: "query",
                  mode: "vsearch",
                  query: "agent retrieval",
                  limit: 1,
                },
              },
            },
          });
          assertCleanProtocolOutput(probe);
          expect(toolPayload(probe, 3).available).toBe(true);
          expect(toolPayload(probe, 4).available).toBe(true);
        } finally {
          await import("node:fs/promises").then(({ rm }) => rm(vault, { recursive: true, force: true }));
        }
      },
      180_000,
    );
  },
);
