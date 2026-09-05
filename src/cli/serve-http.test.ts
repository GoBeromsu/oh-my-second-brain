import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { syncEngineStore } from "../kernel/engine/embed/sync.js";
import { engineStorePath } from "../kernel/engine/paths.js";
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

async function vaultSnapshot(root: string, relative = ""): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      snapshot[`${child}/`] = "directory";
      Object.assign(snapshot, await vaultSnapshot(root, child));
    } else {
      const bytes = await readFile(path.join(root, child));
      snapshot[child] = createHash("sha256").update(bytes).digest("hex");
    }
  }
  return snapshot;
}

describe("serve HTTP transport", () => {
  it.each(["absent", "existing"] as const)(
    "does not mutate the entire vault tree when the engine store is %s",
    async (storeState) => {
      tmpVault = await writeVault();
      modelCacheDir = await mkdtemp(path.join(tmpdir(), "oms-http-model-cache-"));
      if (storeState === "existing") await syncEngineStore({ vault: tmpVault, embed: false });
      const before = await vaultSnapshot(tmpVault);

      httpServer = await runServeHttp({
        vault: tmpVault,
        port: 0,
        modelCacheDir,
        modelEnv: {},
      });
      const health = await fetch(`${httpServer.url}/health`);
      expect(health.status).toBe(200);
      expect(await vaultSnapshot(tmpVault)).toEqual(before);

      await httpServer.close();
      httpServer = undefined;
      expect(await vaultSnapshot(tmpVault)).toEqual(before);
    },
  );

  it("takes a consistent external snapshot while a WAL writer remains active", async () => {
    tmpVault = await writeVault();
    modelCacheDir = await mkdtemp(path.join(tmpdir(), "oms-http-model-cache-"));
    await syncEngineStore({ vault: tmpVault, embed: false });
    const writer = new Database(engineStorePath(tmpVault), { fileMustExist: true });
    try {
      writer.pragma("journal_mode = WAL");
      writer.pragma("wal_autocheckpoint = 0");
      await writeFile(
        path.join(tmpVault, "references", "WAL Only.md"),
        "# WAL Only\n\nwalexclusive committed content.\n",
      );
      const insert = writer.transaction(() => {
        const result = writer.prepare(
          "INSERT INTO engine_chunk_meta (doc_path, ordinal, text, sha) VALUES (?, ?, ?, ?)",
        ).run(
          "references/WAL Only.md",
          0,
          "WAL Only walexclusive committed content",
          "wal-only-sha",
        );
        writer.prepare(
          "INSERT INTO engine_chunk_fts (rowid, doc_path, ordinal, text) VALUES (?, ?, ?, ?)",
        ).run(
          Number(result.lastInsertRowid),
          "references/WAL Only.md",
          0,
          "WAL Only walexclusive committed content",
        );
      });
      insert();
      const before = await vaultSnapshot(tmpVault);
      expect(Object.keys(before)).toContain(".oms/engine-store.sqlite-wal");

      httpServer = await runServeHttp({
        vault: tmpVault,
        port: 0,
        modelCacheDir,
        modelEnv: {},
      });
      const health = await fetch(`${httpServer.url}/health`);
      expect(health.status).toBe(200);
      expect(await vaultSnapshot(tmpVault)).toEqual(before);

      const search = await jsonFetch(`${httpServer.url}/search`, {
        query: "walexclusive",
        limit: 1,
      });
      expect(search).toMatchObject({ available: true });
      expect(search["hits"]).toEqual([
        expect.objectContaining({ path: "references/WAL Only.md" }),
      ]);
      expect(await vaultSnapshot(tmpVault)).toEqual(before);
    } finally {
      await httpServer?.close();
      httpServer = undefined;
      writer.close();
    }
  });

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

    const vectorWithoutModel = await jsonFetch(`${httpServer.url}/search`, {
      vec: "agent retrieval",
      limit: 1,
    });
    expect(vectorWithoutModel).toEqual(
      expect.objectContaining({
        available: false,
        reason: expect.stringMatching(/embedding provider unavailable/i),
      }),
    );

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
