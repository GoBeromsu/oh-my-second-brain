import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildTruthTableRow, type TruthTableFixture } from "../../test/fixtures/contract-truth-table.js";
import type { VaultContract } from "../kernel/contract/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");

const CONTRACT: VaultContract = {
  folders: { references: { meaning: "processed sources", searchExclude: false } },
  properties: { status: { meaning: "state", type: "text", default: false, required: true, rules: [{ kind: "allowed", values: ["open", "done"] }] } },
  templates: {},
};

function textPayload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  const text = block.type === "text" ? block.text : "{}";
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error(text); }
}

describe("Issue #58: Verified-target admission", () => {
  let tmpHome: string | undefined;
  let tmpDocuments: string | undefined;
  let fixture: TruthTableFixture | undefined;

  afterEach(async () => {
    for (const dir of [tmpHome, tmpDocuments]) {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    await fixture?.cleanup();
    tmpHome = tmpDocuments = fixture = undefined;
  });

  it("refuses a current-directory inference and writes nothing", async () => {
    tmpHome = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-home-")));
    tmpDocuments = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-docs-")));

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp"],
      cwd: tmpDocuments,
      env: { HOME: tmpHome, PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      expect((await readdir(tmpDocuments)).length).toBe(0);
      await client.connect(transport);

      const refused = textPayload(await client.callTool({
        name: "write",
        arguments: { path: "references/rejected-note.md", content: "---\nstatus: open\n---\n" },
      }));
      expect(refused.ok).toBe(false);
      expect(refused.status).toBe("rejected");
      expect((refused.rejection as Record<string, unknown>).code).toBe("target-unverified");
      expect((refused.rejection as Record<string, unknown>).message).toContain("current directory");

      // The inferred directory gained nothing.
      expect((await readdir(tmpDocuments)).length).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("judges and saves through an environment-resolved vault", async () => {
    fixture = await buildTruthTableRow("sealed", CONTRACT);
    tmpDocuments = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-docs-")));
    const note = path.join(fixture.vault, "references", "new-note.md");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp"],
      cwd: tmpDocuments,
      env: { HOME: path.join(fixture.base, "home"), OMS_VAULT: fixture.vault, PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const denied = await client.callTool({
        name: "write",
        arguments: { path: "references/new-note.md", content: "---\nstatus: maybe\n---\n" },
      });
      expect(denied.isError).toBe(true);
      expect(textPayload(denied).violations).toEqual([{ field: "status", kind: "not-allowed" }]);
      await expect(readFile(note, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const saved = textPayload(await client.callTool({
        name: "write",
        arguments: { path: "references/new-note.md", content: "---\nstatus: open\n---\n\nBody.\n" },
      }));
      expect(saved).toEqual({ ok: true, path: "references/new-note.md", missingDefaults: [] });
      expect(await readFile(note, "utf8")).toBe("---\nstatus: open\n---\n\nBody.\n");
    } finally {
      await client.close();
    }
  });

  it("does not accept a retired note-write operation", async () => {
    fixture = await buildTruthTableRow("sealed", CONTRACT);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp", "--vault", fixture.vault],
      cwd: repoRoot,
      env: { HOME: path.join(fixture.base, "home"), PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);
      const write = (await client.listTools()).tools.find(tool => tool.name === "write");
      expect(JSON.stringify(write?.inputSchema)).not.toContain('"op"');
      const rejected = await client.callTool({
        name: "write",
        arguments: { op: "note", mode: "create", templateId: "literature", body: "Must not be written." },
      });
      expect(rejected.isError).toBe(true);
      expect((await readdir(fixture.vault)).filter(name => name !== ".oms")).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
