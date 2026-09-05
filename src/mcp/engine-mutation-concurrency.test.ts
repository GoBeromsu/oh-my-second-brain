import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => {
  let disposeEntered!: Promise<void>;
  let disposeProceed!: Promise<void>;
  let cleanupEntered!: Promise<void>;
  let cleanupProceed!: Promise<void>;
  let enterDispose!: () => void;
  let releaseDispose!: () => void;
  let enterCleanup!: () => void;
  let releaseCleanup!: () => void;
  const state = {
    events: [] as string[],
    pauseDispose: false,
    pauseCleanup: false,
    failDispose: false,
    reset() {
      state.events = [];
      state.pauseDispose = false;
      state.pauseCleanup = false;
      state.failDispose = false;
      disposeEntered = new Promise(resolve => { enterDispose = resolve; });
      disposeProceed = new Promise(resolve => { releaseDispose = resolve; });
      cleanupEntered = new Promise(resolve => { enterCleanup = resolve; });
      cleanupProceed = new Promise(resolve => { releaseCleanup = resolve; });
    },
    get disposeEntered() { return disposeEntered; },
    get disposeProceed() { return disposeProceed; },
    get cleanupEntered() { return cleanupEntered; },
    get cleanupProceed() { return cleanupProceed; },
    enterDispose: () => enterDispose(),
    releaseDispose: () => releaseDispose(),
    enterCleanup: () => enterCleanup(),
    releaseCleanup: () => releaseCleanup(),
  };
  state.reset();
  return state;
});

vi.mock("../kernel/engine/assemble.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../kernel/engine/assemble.js")>();
  return {
    ...actual,
    assembleCoreSemanticEngine(config: Parameters<typeof actual.assembleCoreSemanticEngine>[0]) {
      const assembled = actual.assembleCoreSemanticEngine(config);
      const cleanup = assembled.adapter.cleanup.bind(assembled.adapter);
      assembled.adapter.cleanup = async (...args: Parameters<typeof assembled.adapter.cleanup>) => {
        if (boundary.pauseCleanup) {
          boundary.pauseCleanup = false;
          boundary.enterCleanup();
          await boundary.cleanupProceed;
          throw new Error("injected cleanup failure");
        }
        return cleanup(...args);
      };
      return {
        ...assembled,
        async dispose() {
          if (boundary.pauseDispose) {
            boundary.pauseDispose = false;
            boundary.enterDispose();
            await boundary.disposeProceed;
          }
          await assembled.dispose();
          boundary.events.push("engine-dispose-end");
          if (boundary.failDispose) throw new Error("injected close failure");
        },
      };
    },
  };
});

vi.mock("../kernel/doctor/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../kernel/doctor/service.js")>();
  return {
    ...actual,
    async repairDoctor(input: Parameters<typeof actual.repairDoctor>[0]) {
      if (input.operation === "repair-index") boundary.events.push("repair-start");
      return actual.repairDoctor(input);
    },
  };
});

import { writeMorningVaultFixture } from "../kernel/search/morning-test-fixtures.js";
import { createOMSMcpServer } from "./server.js";

const disposable: string[] = [];
let cacheRoot = "";

beforeEach(async () => {
  boundary.reset();
  cacheRoot = await mkdtemp(path.join(tmpdir(), "oms-mcp-concurrency-cache-"));
  disposable.push(cacheRoot);
  vi.stubEnv("XDG_CACHE_HOME", cacheRoot);
  vi.stubEnv("OMS_EMBEDDING_PROVIDER", "");
  vi.stubEnv("OMS_EMBEDDING_MODEL", "");
});

afterEach(async () => {
  boundary.releaseDispose();
  boundary.releaseCleanup();
  vi.unstubAllEnvs();
  await Promise.all(disposable.splice(0).map(item => rm(item, { recursive: true, force: true })));
});

function payload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("missing text payload");
  return JSON.parse(content.text) as Record<string, unknown>;
}

async function connected(vault: string, name: string) {
  const server = createOMSMcpServer({ vault, source: "vault" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

const flushSdk = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe("MCP engine mutation coordination", () => {
  it("holds repair behind sync disposal while readonly graph status remains independent", async () => {
    const vault = await writeMorningVaultFixture();
    disposable.push(vault);
    boundary.pauseDispose = true;
    const { server, client } = await connected(vault, "mutation-concurrency");
    try {
      const sync = client.callTool({ name: "doctor", arguments: { op: "sync-embeddings", mode: "sync" } });
      await boundary.disposeEntered;
      const repair = client.callTool({ name: "doctor", arguments: { op: "sync-embeddings", mode: "repair", repairMode: "rebuild" } });
      const graph = await client.callTool({ name: "status", arguments: { op: "graph" } });
      expect(payload(graph)).toEqual(expect.objectContaining({ available: expect.any(Boolean) }));
      await flushSdk();
      expect(boundary.events).not.toContain("repair-start");

      boundary.releaseDispose();
      expect(payload(await sync).receipt).toMatchObject({ operation: "sync-embeddings" });
      const repaired = payload(await repair);
      expect(boundary.events).toContain("engine-dispose-end");
      expect(boundary.events).toContain("repair-start");
      expect(boundary.events.indexOf("engine-dispose-end")).toBeLessThan(boundary.events.indexOf("repair-start"));
      const postcondition = (repaired.receipt as { postcondition: { backupPaths: string[] } }).postcondition;
      expect(postcondition.backupPaths.length).toBeGreaterThan(0);
      const backupBefore = await Promise.all(postcondition.backupPaths.map(file => readFile(file)));
      const later = payload(await client.callTool({ name: "doctor", arguments: { op: "sync-embeddings", mode: "sync" } }));
      expect(later.receipt).toMatchObject({ postcondition: { databasePath: path.join(vault, ".oms", "engine-store.sqlite") } });
      expect(await Promise.all(postcondition.backupPaths.map(file => readFile(file)))).toEqual(backupBefore);
    } finally {
      boundary.releaseDispose();
      await client.close();
      await server.close();
    }
  });

  it("continues the queue after cleanup fails and its engine closes", async () => {
    const vault = await writeMorningVaultFixture();
    disposable.push(vault);
    boundary.pauseCleanup = true;
    const { server, client } = await connected(vault, "cleanup-concurrency");
    try {
      const cleanup = client.callTool({ name: "doctor", arguments: { op: "cleanup" } });
      await boundary.cleanupEntered;
      const repair = client.callTool({ name: "doctor", arguments: { op: "sync-embeddings", mode: "repair", repairMode: "drop", dryRun: true } });
      await flushSdk();
      expect(boundary.events).not.toContain("repair-start");
      boundary.releaseCleanup();
      expect(await cleanup).toMatchObject({ isError: true });
      expect(payload(await repair)).toMatchObject({ mode: "drop", dryRun: true, receipt: { operation: "repair-index", written: { paths: [] } } });
      expect(boundary.events).toContain("engine-dispose-end");
      expect(boundary.events).toContain("repair-start");
      expect(boundary.events.indexOf("engine-dispose-end")).toBeLessThan(boundary.events.indexOf("repair-start"));
    } finally {
      boundary.releaseCleanup();
      await client.close();
      await server.close();
    }
  });

  it("fails closed after a writable engine cannot be disposed without depending on earlier tests", async () => {
    const vault = await writeMorningVaultFixture();
    disposable.push(vault);
    boundary.failDispose = true;
    const { server, client } = await connected(vault, "dispose-failure");
    try {
      const sync = await client.callTool({ name: "doctor", arguments: { op: "sync-embeddings", mode: "sync" } });
      const syncText = sync.content[0]?.type === "text" ? sync.content[0].text : "";
      expect(syncText).toContain("ENGINE_LIFECYCLE_FAILED");
      const repair = await client.callTool({ name: "doctor", arguments: { op: "sync-embeddings", mode: "repair", repairMode: "drop", dryRun: true } });
      const repairText = repair.content[0]?.type === "text" ? repair.content[0].text : "";
      expect(repairText).toContain("ENGINE_LIFECYCLE_FAILED");
      expect(repairText).toContain("Restart the MCP server");
    } finally {
      boundary.failDispose = false;
      await client.close();
      await server.close();
    }
  });
});
