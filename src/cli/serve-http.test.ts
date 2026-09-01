import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncEngineStore } from "../kernel/engine/embed/sync.js";
import { runServeHttp, type ServeHttpServer } from "./serve-http.js";

let tmpVault: string | undefined;
let modelCacheDir: string | undefined;
let httpServer: ServeHttpServer | undefined;

afterEach(async () => {
  if (httpServer) {
    await httpServer.close();
    httpServer = undefined;
  }
  if (tmpVault) {
    await rm(tmpVault, { recursive: true, force: true });
    tmpVault = undefined;
  }
  if (modelCacheDir) {
    await rm(modelCacheDir, { recursive: true, force: true });
    modelCacheDir = undefined;
  }
});

async function writeVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-http-serve-"));
  await mkdir(path.join(vault, "references"), { recursive: true });
  await writeFile(
    path.join(vault, "references", "Agent Retrieval.md"),
    `---
title: Agent Retrieval
---
# Agent Retrieval

Agent retrieval works over direct HTTP query transport.
`,
    "utf-8",
  );
  return vault;
}

async function jsonFetch(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  const parsed: unknown = await response.json();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected object JSON response.");
  }
  return parsed as Record<string, unknown>;
}

describe("serve HTTP transport", () => {
  it("serves only canonical health, search, and document endpoints", async () => {
    tmpVault = await writeVault();
    modelCacheDir = await mkdtemp(path.join(tmpdir(), "oms-http-model-cache-"));
    // Model-less: a lex-only sync populates the engine FTS index (no vectors).
    await syncEngineStore({ vault: tmpVault, embed: false });
    httpServer = await runServeHttp({
      vault: tmpVault,
      port: 0,
      modelCacheDir,
      modelEnv: {},
    });

    const healthResponse = await fetch(`${httpServer.url}/health`);
    expect(healthResponse.ok).toBe(true);
    await expect(healthResponse.json()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        storage: "oms-native-json",
      }),
    );

    const search = await jsonFetch(`${httpServer.url}/search`, {
      lex: "agent retrieval",
      collection: "obsidian",
      limit: 1,
    });
    const hits = search["hits"];
    expect(Array.isArray(hits)).toBe(true);
    expect(hits).toEqual([expect.objectContaining({ path: "references/Agent Retrieval.md" })]);

    // A plain query is lexical-only regardless of installed models. This
    // isolated model-less server proves it never demands a deferred vector.
    const modelLessSearch = await jsonFetch(`${httpServer.url}/search`, {
      query: "agent retrieval",
      limit: 1,
    });
    expect(modelLessSearch).toEqual(expect.objectContaining({ available: true }));
    expect(modelLessSearch["hits"]).toEqual([
      expect.objectContaining({ path: "references/Agent Retrieval.md" }),
    ]);

    const document = await jsonFetch(`${httpServer.url}/get`, {
      target: "references/Agent Retrieval.md",
    });
    expect(document).toEqual({
      available: true,
      documents: [expect.objectContaining({ path: "references/Agent Retrieval.md" })],
    });

    const documents = await jsonFetch(`${httpServer.url}/multi-get`, {
      targets: ["references/Agent Retrieval.md"],
    });
    expect(documents).toEqual({
      available: true,
      documents: [expect.objectContaining({ path: "references/Agent Retrieval.md" })],
    });
  });

  it("rejects retired and unsupported HTTP endpoints deterministically", async () => {
    tmpVault = await writeVault();
    modelCacheDir = await mkdtemp(path.join(tmpdir(), "oms-http-model-cache-"));
    httpServer = await runServeHttp({ vault: tmpVault, port: 0, modelCacheDir, modelEnv: {} });

    for (const pathName of ["/query", "/mcp", "/collections", "/contexts", "/cleanup"]) {
      const response = await fetch(`${httpServer.url}${pathName}`, { method: "POST" });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "Unknown OMS search HTTP endpoint.",
      });
    }

    const wrongMethod = await fetch(`${httpServer.url}/search`);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
    await expect(wrongMethod.json()).resolves.toEqual({
      ok: false,
      reason: "Method not allowed.",
    });

    const unknown = await fetch(`${httpServer.url}/unknown`);
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual({
      ok: false,
      reason: "Unknown OMS search HTTP endpoint.",
    });
  });
});
