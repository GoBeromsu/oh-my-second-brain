import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sealContract } from "../kernel/contract/store.js";
import type { VaultContract } from "../kernel/contract/types.js";
import { serializeVaultSettings, SETTINGS_PATH } from "../kernel/vault/settings.js";
import { createOMSMcpServer, omsMcpTools } from "./server.js";

function validate(tool: string, input: Record<string, unknown>): boolean {
  const schema = omsMcpTools.find(candidate => candidate.name === tool)?.inputSchema;
  if (schema === undefined) throw new Error(`missing ${tool} schema`);
  return new AjvJsonSchemaValidator().getValidator(schema)(input).valid;
}

describe("template-native MCP surface", () => {
  it("keeps template listing, showing, and document reads mutually exclusive", () => {
    expect(validate("search", { op: "template-scan" })).toBe(false);
    expect(validate("search", { op: "templates" })).toBe(true);
    expect(validate("search", { op: "templates", templateId: "note" })).toBe(false);
    expect(validate("search", { op: "get-document", target: "notes/a.md" })).toBe(true);
    expect(validate("search", { op: "get-document", targets: ["notes/a.md"] })).toBe(true);
    expect(validate("search", { op: "get-document", notePath: "notes/a.md", fromLine: 1, lineCount: 20 })).toBe(true);
    expect(validate("search", { op: "get-document", target: "notes/a.md", targets: ["notes/a.md"] })).toBe(false);
  });

  it("advertises one write payload: {path, content, template?, ifMatch?, check?}", () => {
    expect(validate("write", { path: "notes/a.md", content: "body" })).toBe(true);
    expect(validate("write", { path: "notes/a.md", content: "body", template: "note" })).toBe(true);
    expect(validate("write", { path: "notes/a.md", content: "body", ifMatch: `sha256:${"0".repeat(64)}`, check: true })).toBe(true);
    expect(validate("write", { path: "notes/a.md", content: "body", check: "yes" })).toBe(false);
    expect(validate("write", { path: "notes/a.md", content: "body", ifMatch: 1 })).toBe(false);
    expect(validate("write", { path: "notes/a.md" })).toBe(false);
    expect(validate("write", { content: "body" })).toBe(false);
    // Retired guide/check/template branches have no schema at all.
    expect(validate("write", { op: "guide", notePath: "notes/a.md", templateId: "note" })).toBe(false);
    expect(validate("write", { op: "check", connectionId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222" })).toBe(false);
    expect(validate("write", { op: "template", mode: "publish-contract", policy: { version: 5 }, transactionId: "33333333-3333-4333-8333-333333333333" })).toBe(false);
    expect(validate("write", { path: "notes/a.md", content: "body", templateId: "note" })).toBe(false);
  });

  it("keeps link suggestion under search, link checking under doctor, and doctor free of note backfill", () => {
    expect(validate("search", { op: "link", notePath: "notes/a.md" })).toBe(true);
    expect(validate("search", { op: "link" })).toBe(false);
    expect(validate("doctor", { op: "link-check", notePath: "notes/a.md" })).toBe(true);
    expect(validate("doctor", { op: "link-check" })).toBe(false);
    expect(validate("search", { op: "apply", notePath: "notes/a.md", baseContentHash: "0".repeat(64), candidateIds: [] })).toBe(false);
    expect(validate("doctor", { op: "apply", notePath: "notes/a.md", baseContentHash: "0".repeat(64), candidateIds: [] })).toBe(false);
    expect(omsMcpTools.map(tool => tool.name)).not.toContain("link");
    expect(omsMcpTools.map(tool => tool.name)).not.toContain("status");
    expect(validate("doctor", { op: "status" })).toBe(true);
    expect(validate("interview", {})).toBe(true);
    expect(validate("interview", { reask: true })).toBe(true);
    expect(validate("interview", { op: "answer", answers: {} })).toBe(true);
    expect(validate("interview", { op: "confirm", proposed: "digest" })).toBe(true);
    expect(validate("interview", { op: "reclaim" })).toBe(false);
    expect(validate("interview", { op: "seal", confirmStaleReclaim: true })).toBe(false);
    expect(validate("doctor", { op: "validate" })).toBe(true);
    expect(validate("doctor", { op: "backfill-defaults", notePath: "notes/a.md", dryRun: true })).toBe(false);
  });

  it("uses query and index discriminators without retired aliases", () => {
    expect(validate("search", { op: "query", query: "lexical default" })).toBe(true);
    expect(validate("search", { op: "query", mode: "vsearch", query: "vector" })).toBe(true);
    expect(validate("search", { op: "query", searches: [{ type: "lex", query: "typed" }] })).toBe(true);
    expect(validate("search", { op: "query", mode: "query", searches: [{ type: "lex", query: "typed" }] })).toBe(false);
    expect(validate("search", { op: "query", query: "one", searches: [{ type: "lex", query: "two" }] })).toBe(false);
    expect(validate("search", { op: "index-status", view: "status" })).toBe(true);
    expect(validate("search", { op: "index-status", view: "collections" })).toBe(true);
    expect(validate("search", { op: "index-status", view: "contexts" })).toBe(true);
    expect(validate("search", { op: "collections" })).toBe(false);
  });

  it("keeps index repair exclusive from sync and embed options", () => {
    expect(validate("doctor", { op: "sync-embeddings", mode: "repair", repairMode: "rebuild" })).toBe(true);
    expect(validate("doctor", { op: "sync-embeddings", mode: "repair", repairMode: "drop", dryRun: true })).toBe(true);
    expect(validate("doctor", { op: "sync-embeddings", mode: "repair" })).toBe(false);
    expect(validate("doctor", { op: "sync-embeddings", mode: "sync", repairMode: "drop" })).toBe(false);
    expect(validate("doctor", { op: "sync-embeddings", mode: "embed", dryRun: true })).toBe(false);
  });
});

describe("template scaffolds, never judges", () => {
  const CONTRACT: VaultContract = {
    folders: { Projects: { meaning: "project notes", searchExclude: false } },
    properties: { status: { meaning: "lifecycle", type: "text", default: false, required: true, rules: [{ kind: "allowed", values: ["active", "done"] }] } },
  };
  const disposable: string[] = [];
  let vault = "";

  type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

  function payload(result: ToolResult): Record<string, unknown> {
    const content = (result.content as Array<{ type: string; text?: string }>)[0];
    if (content?.type !== "text" || content.text === undefined) throw new Error("missing text payload");
    return JSON.parse(content.text) as Record<string, unknown>;
  }

  async function write(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const server = createOMSMcpServer({ vault, source: "vault" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "template-native", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return payload(await client.callTool({ name: "write", arguments: args }) as ToolResult);
    } finally {
      await client.close();
    }
  }

  beforeEach(async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "oms-template-native-")));
    disposable.push(base);
    const home = path.join(base, "home");
    await mkdir(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("OMS_RUNTIME_ROOT", path.join(base, "runtime"));
    vi.stubEnv("OMS_VAULT", "");
    vault = path.join(base, "vault");
    await mkdir(path.join(vault, "Projects"), { recursive: true });
    await mkdir(path.join(vault, "Templates"));
    await mkdir(path.join(vault, ".oms"));
    const vaultId = randomUUID();
    await writeFile(path.join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId, templateFolder: "Templates" }));
    await writeFile(path.join(vault, "Templates/Projects.md"), "---\nstatus: active\nowner: me\n---\n## Goals\n");
    await sealContract({ vaultRealPath: await realpath(vault), vaultId, contract: CONTRACT }, path.join(home, ".oms", "vaults"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(disposable.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  it("scaffolds a new note from the live template, and an edited template needs no reseal", async () => {
    expect(await write({ path: "Projects/a.md", content: "# A\n" })).toMatchObject({ ok: true });
    expect(await readFile(path.join(vault, "Projects/a.md"), "utf8")).toBe("---\nstatus: active\nowner: me\n---\n# A\n\n## Goals\n");

    await writeFile(path.join(vault, "Templates/Projects.md"), "---\nstatus: done\n---\n## Risks\n");
    expect(await write({ path: "Projects/b.md", content: "# B\n" })).toMatchObject({ ok: true });
    expect(await readFile(path.join(vault, "Projects/b.md"), "utf8")).toBe("---\nstatus: done\n---\n# B\n\n## Risks\n");
  }, 60_000);

  it("keeps the note's own values over the template's and judges only the note, by the property contract", async () => {
    const kept = await write({ path: "Projects/c.md", content: "---\nstatus: done\n---\n## Other\n", template: "Projects" });
    // The scaffolded `owner` is not in the property contract, so it is warned like any other unknown key.
    expect(kept).toMatchObject({
      ok: true,
      conformed: [{ field: "owner", action: "default" }, { field: "Goals", action: "heading" }],
      warnings: [{ field: "owner", kind: "unknown-property" }],
    });
    expect(await readFile(path.join(vault, "Projects/c.md"), "utf8")).toBe("---\nstatus: done\nowner: me\n---\n## Other\n\n## Goals\n");

    // The template's own value is outside the allowed set; only the note's value is ever judged.
    await writeFile(path.join(vault, "Templates/Projects.md"), "---\nstatus: bogus\n---\n## Goals\n");
    expect(await write({ path: "Projects/e.md", content: "---\nstatus: active\n---\nbody\n" }))
      .toMatchObject({ ok: true, conformed: [{ field: "Goals", action: "heading" }], warnings: [], fixes: [] });
    expect(await readFile(path.join(vault, "Projects/e.md"), "utf8")).toBe("---\nstatus: active\n---\nbody\n\n## Goals\n");
  }, 60_000);

  it("writes a note whose named template is not live, unscaffolded, with a missing-template entry", async () => {
    expect(await write({ path: "Projects/d.md", content: "---\nstatus: active\n---\nbody\n", template: "Nowhere" }))
      .toMatchObject({ ok: true, conformed: [{ field: "Nowhere", action: "template-missing" }] });
    expect(await readFile(path.join(vault, "Projects/d.md"), "utf8")).toBe("---\nstatus: active\n---\nbody\n");
  }, 60_000);
});
