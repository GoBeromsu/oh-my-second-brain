import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSettings } from "../../test/fixtures/contract-truth-table.js";
// @ts-expect-error -- plain .mjs fixture helper shared with the bench script; it has no type declarations.
import { materializeKoVault } from "../../test/fixtures/ko-vault.mjs";
import { sealContract } from "../kernel/contract/store.js";
import type { VaultContract } from "../kernel/contract/types.js";
import { createOMSMcpServer } from "./server.js";

/**
 * A note written through MCP `write` is findable by the store-backed keyword
 * search in the very next call: the write updates the existing index itself,
 * without a doctor sync in between.
 */

const CONTRACT: VaultContract = {
  folders: {
    Projects: { meaning: "project notes", searchExclude: false },
    Areas: { meaning: "ongoing areas", searchExclude: false },
    Resources: { meaning: "reference material", searchExclude: false },
    지식: { meaning: "knowledge notes", searchExclude: false },
    Daily: { meaning: "daily notes", searchExclude: false },
  },
  properties: {
    status: { meaning: "note lifecycle", type: "text", default: false, required: true, rules: [{ kind: "allowed", values: ["진행중", "완료", "보류", "active"] }] },
  },
  templates: {},
};

const KEYWORD = "낙상예방캠페인";
const disposable: string[] = [];
let base = "";
let vault = "";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function payload(result: ToolResult): Record<string, unknown> {
  const content = (result.content as Array<{ type: string; text?: string }>)[0];
  if (content?.type !== "text" || content.text === undefined) throw new Error("missing text payload");
  return JSON.parse(content.text) as Record<string, unknown>;
}

function hitPaths(result: ToolResult): string[] {
  const hits = (payload(result)["hits"] ?? []) as Array<Record<string, unknown>>;
  return hits.map(hit => String(hit["path"] ?? hit["file"] ?? ""));
}

async function connected(): Promise<Client> {
  const server = createOMSMcpServer({ vault, source: "vault" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "write-ko-vault", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const search = (client: Client): Promise<ToolResult> =>
  client.callTool({ name: "search", arguments: { op: "query", mode: "query", query: KEYWORD } }) as Promise<ToolResult>;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "oms-write-ko-")));
  disposable.push(base);
  const home = path.join(base, "home");
  for (const dir of ["home", "cache", "config", "runtime"]) await mkdir(path.join(base, dir), { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CACHE_HOME", path.join(base, "cache"));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(base, "config"));
  vi.stubEnv("OMS_RUNTIME_ROOT", path.join(base, "runtime"));
  vi.stubEnv("OMS_VAULT", "");
  vi.stubEnv("OMS_EMBEDDING_PROVIDER", "");
  vi.stubEnv("OMS_EMBEDDING_MODEL", "");
  vault = materializeKoVault(path.join(base, "vault")) as string;
  const vaultId = randomUUID();
  await writeSettings(vault, vaultId);
  await sealContract({ vaultRealPath: await realpath(vault), vaultId, contract: CONTRACT }, path.join(home, ".oms", "vaults"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(disposable.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("MCP write on the ko-vault", () => {
  it("makes a new Korean keyword searchable in the same call", async () => {
    const client = await connected();
    try {
      const synced = await client.callTool({ name: "doctor", arguments: { op: "sync-embeddings", mode: "sync" } }) as ToolResult;
      expect(synced.isError ?? false).toBe(false);
      expect(hitPaths(await search(client))).toEqual([]);

      const content = `---\nstatus: 진행중\n---\n# 낙상 예방\n\n병동 전체에 ${KEYWORD}을 시작한다.\n`;
      const written = payload(await client.callTool({ name: "write", arguments: { path: "Projects/낙상 예방.md", content } }) as ToolResult);
      expect(written).toMatchObject({ ok: true, path: "Projects/낙상 예방.md", index: { keyword: "updated" } });
      expect(await readFile(path.join(vault, "Projects", "낙상 예방.md"), "utf8")).toBe(content);

      expect(hitPaths(await search(client))).toContain("Projects/낙상 예방.md");
    } finally {
      await client.close();
    }
  }, 120_000);

  it("reports the index as skipped and writes the note when no store exists yet", async () => {
    const client = await connected();
    try {
      const content = `---\nstatus: active\n---\n${KEYWORD}\n`;
      const written = payload(await client.callTool({ name: "write", arguments: { path: "Projects/new.md", content } }) as ToolResult);
      expect(written).toMatchObject({ ok: true, index: { keyword: "skipped" } });
      expect(await readFile(path.join(vault, "Projects", "new.md"), "utf8")).toBe(content);
    } finally {
      await client.close();
    }
  }, 60_000);
});
