import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { writeContractVault } from "../kernel/templates/approved-vault-fixture.js";
import { demotedOperationNames } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../");
const fixtureVault = path.join(repoRoot, "test", "fixtures", "vault");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");

async function createTemplateAuthority(vault: string): Promise<void> {
  await writeContractVault(vault, {
    properties: {
      title: { type: "text", intent: "Note title." },
      status: { type: "select", intent: "Workflow state.", allowedValues: ["open", "closed"] },
    },
    templates: {
      note: {
        fields: ["title", "status"],
        optionalFields: ["status"],
        approvedMarkdown: "---\ntemplate: note\ntitle: Untitled\nstatus: open\n---\n\n# Note\n",
        rawSource: { path: "Templates/OMS/note.md", identity: "note-source", bytes: "---\ntemplate: note\n---\n# Note\n" },
        targetFolder: "references",
      },
    },
    folders: { references: { intent: "Processed sources." } },
    obsidianTypes: { title: "text", status: "select" },
  });
  const targetPath = path.join(vault, "references", "clean-architecture.md");
  const target = await readFile(targetPath, "utf-8");
  await writeFile(targetPath, target.replace(/^---\n/u, "---\ntemplate: note\n"), "utf-8");
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  const text = block?.type === "text" ? block.text : "{}";
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error(text); }
}

function expectAdvertisedArguments(tool: Tool, args: Record<string, unknown>): void {
  const schema = tool.inputSchema as {
    oneOf?: { properties?: Record<string, unknown>; required?: string[] }[];
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const branches = schema.oneOf ?? [schema];
  const branch = branches.find((candidate) => {
    const properties = candidate.properties ?? {};
    return Object.entries(args).every(([key, value]) => {
      const property = properties[key] as { const?: unknown; type?: string; items?: { type?: string } } | undefined;
      if (!property) return false;
      if (property.const !== undefined) return property.const === value;
      if (property.type === "array") return Array.isArray(value) && (property.items?.type !== "string" || value.every((item) => typeof item === "string"));
      return property.type === undefined || typeof value === property.type;
    }) && (candidate.required ?? []).every((key) => key in args);
  });
  expect(branch, `${tool.name} must advertise ${JSON.stringify(args)}`).toBeDefined();
}

describe("MCP detail-tool demotion", () => {
  it("keeps every demoted implementation reachable behind the five-tool surface", async () => {
    const client = new Client({ name: "demotion-test", version: "0" });
    const vault = await mkdtemp(path.join(tmpdir(), "oms-demotion-"));
    await cp(fixtureVault, vault, { recursive: true });
    await createTemplateAuthority(vault);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [distCli, "serve", "mcp", "--vault", vault], cwd: repoRoot, stderr: "pipe" }));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
      const call = (name: string, arguments_: Record<string, unknown>) => {
        const tool = tools.get(name);
        expect(tool).toBeDefined();
        expectAdvertisedArguments(tool!, arguments_);
        return client.callTool({ name, arguments: arguments_ });
      };
      expect(names).toEqual(["write", "search", "link", "status", "doctor"]);
      expect(names).not.toEqual(expect.arrayContaining(demotedOperationNames));
      expect(payload(await call("status", {})).derivedState).toBeDefined();
      expect(payload(await call("doctor", { op: "audit", folder: "references" })).scannedNotes).toBeTypeOf("number");
      expect(payload(await call("doctor", { op: "validate" })).status).toBeTypeOf("string");
      expect(payload(await call("doctor", { op: "build-graph" })).notes).toBeTypeOf("number");
      const scan = payload(await call("search", { op: "template-scan" }));
      expect(scan).toMatchObject({
        generationDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        common: "active",
        registrations: [expect.objectContaining({
          templateId: "note",
          status: "active",
          path: "Templates/OMS/note.md",
          state: "unchanged",
        })],
      });
      // Review evidence carries digests, never raw bytes or approved Markdown.
      expect(JSON.stringify(scan)).not.toContain('"bytes"');
      expect(JSON.stringify(scan)).not.toContain("approvedMarkdown\":\"");
      expect(payload(await call("search", { op: "templates" })).templates).toBeInstanceOf(Array);
      // The derived projection repair is retired: the explicit contract is the
      // authority, so it is neither advertised nor reachable, with no alias.
      expect(JSON.stringify(tools.get("doctor")?.inputSchema)).not.toContain("regenerate-types");
      expect(payload(await call("search", { op: "context", folder: "references", useCache: false })).hits).toBeInstanceOf(Array);
      expect(payload(await call("search", { op: "get-document", target: "references/clean-architecture.md" })).documents).toBeInstanceOf(Array);
      expect(payload(await call("search", { op: "get-document", targets: ["references/clean-architecture.md"] })).documents).toBeInstanceOf(Array);
      const suggested = payload(await call("link", { op: "suggest", notePath: "references/clean-architecture.md" }));
      expect(suggested.baseContentHash).toBeTypeOf("string");
      const beforeLinkCheck = await readFile(path.join(vault, "references/clean-architecture.md"));
      const linkCheck = payload(await call("link", { op: "check", notePath: "references/clean-architecture.md" }));
      expect(linkCheck.links).toBeInstanceOf(Array);
      // The read-only link tool leaves the note exactly as the agent saved it.
      expect(await readFile(path.join(vault, "references/clean-architecture.md"))).toEqual(beforeLinkCheck);
      for (const view of ["status", "collections", "contexts"]) {
        const result = await call("search", { op: "index-status", view });
        expect(result.content[0]?.type).toBe("text");
        expect(result.content[0]?.type === "text" ? result.content[0].text : "").toMatch(
          /OMS_EMBEDDING_PROVIDER|available|collections|contexts/,
        );
      }
      const query = await call("search", { op: "query", query: "architecture" });
      expect(query.content[0]?.type).toBe("text");
      const cleanup = await call("doctor", { op: "cleanup" });
      expect(cleanup.content[0]?.type).toBe("text");
      expect(cleanup.content[0]?.type === "text" ? cleanup.content[0].text : "").toMatch(
        /OMS_EMBEDDING_PROVIDER|available/,
      );
      for (const mode of ["sync", "embed"]) {
        const result = await call("doctor", { op: "sync-embeddings", mode });
        expect(result.content[0]?.type).toBe("text");
        expect(result.content[0]?.type === "text" ? result.content[0].text : "").toMatch(
          /OMS_EMBEDDING_PROVIDER|available/,
        );
      }
      expect(payload(await call("doctor", {
        op: "sync-embeddings", mode: "repair", repairMode: "rebuild", dryRun: true,
      }))).toMatchObject({ mode: "rebuild", dryRun: true, resolvedVault: vault });
      await expect(client.listResourceTemplates()).rejects.toThrow(/Method not found/);
    } finally { await client.close(); await rm(vault, { recursive: true, force: true }); }
  }, 120_000);
});
