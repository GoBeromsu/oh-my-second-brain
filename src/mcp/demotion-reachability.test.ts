import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { sourceSignature } from "../kernel/templates/index.js";
import type { SourceDescriptor } from "../kernel/templates/types.js";
import { createHash } from "node:crypto";
import { demotedOperationNames } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../");
const fixtureVault = path.join(repoRoot, "test", "fixtures", "vault");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function createTemplateAuthority(vault: string): Promise<void> {
  const policy = JSON.stringify({ version: 3, templateFolders: [{ path: "Templates/OMS", mode: "manual", default: true }], base: { fields: {} }, contracts: { note: { intent: "A note.", fields: { template: { type: "text", required: true }, title: { type: "text", required: true }, status: { type: "select", required: true, allowedValues: ["open", "closed"] } }, views: [] } }, templates: { note: { templateId: "note", destinationClass: "managed-default", renderer: "obsidian-core", sourceFolder: "Templates/OMS", sourcePath: "Templates/OMS/note.md", contract: "note", naming: "{{slug}}.md" } } });
  const taxonomy = JSON.stringify({ folders: {}, templates: { note: { templateFolder: "Inbox" } } });
  const obsidianTypes = JSON.stringify({ types: { template: "text", title: "text", status: "select" } });
  const template = "---\ntemplate: note\ntitle: Untitled\nstatus: open\n---\n# Note\n<!-- oms:content -->\n";
  const sources: SourceDescriptor[] = [
    { logicalId: "template-policy", signature: digest(policy) },
    { logicalId: "taxonomy", signature: digest(taxonomy) },
    { logicalId: "obsidian-types", signature: digest(obsidianTypes) },
    { path: "Templates/OMS/note.md", signature: digest(template) },
  ];
  const projection = JSON.stringify({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sources), sources }, managed: { base: { fields: {} }, globalAxes: {}, templates: { note: { templateId: "note", destinationClass: "managed-default", renderer: "obsidian-core", sourcePath: "Templates/OMS/note.md", targetFolder: "Inbox", keyOrder: ["template", "title", "status"], fields: { template: { type: "text", required: true }, title: { type: "text", required: true }, status: { type: "select", required: true, allowedValues: ["open", "closed"] } }, views: [], naming: "{{slug}}.md", bodySignature: digest("# Note\n<!-- oms:content -->\n") } } } });
  await Promise.all([mkdir(path.join(vault, ".oms"), { recursive: true }), mkdir(path.join(vault, ".obsidian"), { recursive: true }), mkdir(path.join(vault, "Templates", "OMS"), { recursive: true })]);
  await Promise.all([writeFile(path.join(vault, ".oms", "template-policy.json"), policy), writeFile(path.join(vault, ".oms", "taxonomy.json"), taxonomy), writeFile(path.join(vault, ".oms", "types.json"), projection), writeFile(path.join(vault, ".obsidian", "types.json"), obsidianTypes), writeFile(path.join(vault, "Templates", "OMS", "note.md"), template)]);
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
      expect(payload(await call("search", { op: "template-scan" })).candidates).toBeInstanceOf(Array);
      expect(payload(await call("search", { op: "templates" })).templates).toBeInstanceOf(Array);
      expect(payload(await call("doctor", { op: "regenerate-types", dryRun: true })).status).toMatch(/planned|unchanged/);
      const beforeBackfill = await readFile(path.join(vault, "references/clean-architecture.md"));
      const backfill = payload(await call("doctor", { op: "backfill-defaults", notePath: "references/clean-architecture.md", dryRun: true }));
      expect(backfill).toMatchObject({ status: "rejected", code: "MIGRATION_NOTE_IDENTITY_UNRESOLVED" });
      expect(await readFile(path.join(vault, "references/clean-architecture.md"))).toEqual(beforeBackfill);
      expect(payload(await call("search", { op: "context", folder: "references", useCache: false })).hits).toBeInstanceOf(Array);
      expect(payload(await call("search", { op: "get-document", target: "references/clean-architecture.md" })).documents).toBeInstanceOf(Array);
      expect(payload(await call("search", { op: "get-document", targets: ["references/clean-architecture.md"] })).documents).toBeInstanceOf(Array);
      const suggested = payload(await call("link", { op: "suggest", notePath: "references/clean-architecture.md" }));
      expect(suggested.baseContentHash).toBeTypeOf("string");
      const apply = await call("link", { op: "apply", notePath: "references/clean-architecture.md", baseContentHash: "0".repeat(64), candidateIds: [] });
      expect(apply.content[0]?.type).toBe("text");
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
      for (const mode of ["sync", "embed", "repair"]) {
        const result = await call("doctor", { op: "sync-embeddings", mode });
        expect(result.content[0]?.type).toBe("text");
        expect(result.content[0]?.type === "text" ? result.content[0].text : "").toMatch(
          /OMS_EMBEDDING_PROVIDER|available/,
        );
      }
      await expect(client.listResourceTemplates()).rejects.toThrow(/Method not found/);
    } finally { await client.close(); await rm(vault, { recursive: true, force: true }); }
  }, 120_000);
});
