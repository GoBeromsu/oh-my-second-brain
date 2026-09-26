import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { parse } from "yaml";
import { harnessSurfaceRegistry } from "../kernel/harness/surface-registry.js";
import { createOMSMcpServer, omsMcpTools } from "./server.js";
import { writeContractVault } from "../kernel/contract/contract-vault-fixture.js";
import type { VaultContract } from "../kernel/contract/types.js";
import { serializeVaultSettings } from "../kernel/vault/settings.js";
import { buildTruthTableRow } from "../../test/fixtures/contract-truth-table.js";

const LITERATURE_MARKDOWN = "---\ntemplate: literature\ntitle: Untitled\nsource-url:\n---\n\n# Literature\n";
const NOTE_MARKDOWN = "---\ntemplate: note\ntitle: Untitled\n---\n\nBody\n";
const ARTICLE_MARKDOWN = "---\ntemplate: article\ntitle: Untitled\n---\n\n# Required heading\n";

/** The explicit V5 authority the write and retrieval surfaces read. */
async function createMcpContractAuthority(vault: string, contractStoreRoot = childStoreRoot()): Promise<void> {
  await writeContractVault(vault, {
    contractStoreRoot,
    properties: {
      title: { type: "text", intent: "Note title." },
      "source-url": { type: "text", intent: "Where the source came from." },
    },
    templates: {
      literature: { fields: ["title", "source-url"], approvedMarkdown: LITERATURE_MARKDOWN, targetFolder: "references" },
    },
    folders: { references: { intent: "Processed sources." } },
    obsidianTypes: { title: "text", "source-url": "text" },
  });
}

async function createLinkTemplateAuthority(vault: string): Promise<void> {
  await writeContractVault(vault, {
    contractStoreRoot: childStoreRoot(),
    properties: { title: { type: "text", intent: "Note title." } },
    templates: {
      note: {
        fields: ["title"],
        approvedMarkdown: NOTE_MARKDOWN,
        targetFolder: "notes",
      },
    },
    folders: { notes: { intent: "Notes." } },
    obsidianTypes: { title: "text", aliases: "aliases" },
  });
}

async function createMcpMetadataAuthority(vault: string): Promise<{ readonly template: string }> {
  await writeContractVault(vault, {
    contractStoreRoot: childStoreRoot(),
    properties: { title: { type: "text", intent: "Article title." } },
    templates: {
      article: {
        fields: ["title"],
        headings: [{ headingId: "required-heading", title: "Required heading", level: 1 }],
        approvedMarkdown: ARTICLE_MARKDOWN,
        targetFolder: "notes",
      },
    },
    folders: { notes: { intent: "Notes." } },
    obsidianTypes: { title: "text" },
  });
  return { template: ARTICLE_MARKDOWN };
}


/** A sealed contract for the write-judge rows: one registered folder, one template. */
const SEALED_WRITE_CONTRACT: VaultContract = {
  folders: { Projects: { meaning: "project notes", searchExclude: false } },
  properties: {
    status: { meaning: "state", type: "text", default: false, required: true, rules: [{ kind: "allowed", values: ["active", "done"] }] },
    owner: { meaning: "who", type: "text", default: true, required: false, rules: [] },
  },
  templates: {
    project: { source: "Templates/project.md", sourceHash: `sha256:${"0".repeat(64)}`, applyFolder: "Projects", requiredProperties: ["status"], narrowedRules: {}, requiredHeadings: ["Goals"] },
  },
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../");
const fixtureVault = path.join(repoRoot, "test", "fixtures", "vault");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");

// Every StdioClientTransport in this file must build its env through
// stdioEnv() below rather than omitting the `env` key. Omitting it is NOT
// "no override": the SDK's own fallback (getDefaultEnvironment() in
// @modelcontextprotocol/sdk/client/stdio.js) inherits the real HOME (and, on
// Windows, USERPROFILE) from this process whenever `env` is left unset - a
// second, easy-to-miss leak path distinct from the `{ ...process.env }`
// spreads this suite already isolates. `oms mcp` performs no global write
// today, so this is a latent hazard rather than a live bug, but nothing here
// should rely on that staying true.
let smokeHome = "";
/** Where a child spawned with `stdioEnv()` reads sealed contracts. */
const childStoreRoot = (): string => path.join(smokeHome, ".oms", "vaults");
const realOmsDir = path.join(homedir(), ".oms");

/**
 * Env for a StdioClientTransport-spawned CLI child, isolated the same way
 * scripts/release-artifact-smoke.mjs's smokeEnv() isolates its own child
 * processes: inherit real process.env for everything else, but always point
 * HOME/USERPROFILE at the throwaway `smokeHome` instead of the real one.
 */
function stdioEnv(
  overrides?: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return { ...process.env, HOME: smokeHome, USERPROFILE: smokeHome, ...overrides };
}

// Metadata-only (size + mtime, not content) recursive snapshot, used to prove
// this suite never touches the real home directory. Reading full file
// content would be correct too, but `~/.oms` can hold a large downloaded
// embedding model, and hashing that on every test run would make the suite
// needlessly slow; size + mtime already changes on any write a real CLI
// invocation could make.
function snapshotDir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const entries: string[] = [];
  const walk = (current: string, rel: string) => {
    for (const name of readdirSync(current).sort()) {
      const absChild = path.join(current, name);
      const relChild = rel === "" ? name : `${rel}/${name}`;
      const st = statSync(absChild);
      if (st.isDirectory()) {
        entries.push(`${relChild}/`);
        walk(absChild, relChild);
      } else {
        entries.push(`${relChild}:${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(dir, "");
  return entries.join("\n");
}

let realOmsBefore: string | null = null;

beforeAll(async () => {
  realOmsBefore = snapshotDir(realOmsDir);
  // A canonical fixture home keeps the kernel's symlink refusal for private
  // control paths intact instead of relaxing it for /var on macOS.
  smokeHome = await realpath(await mkdtemp(path.join(tmpdir(), "oms-mcp-server-home-")));
});

afterAll(async () => {
  // Three sites in this file (the cwd-resolution and doctor-cwd tests) build
  // their own per-test `tmpHome` instead of using smokeHome - they already
  // isolate correctly and are left as-is rather than unified for its own
  // sake. Every other StdioClientTransport in the file now goes through
  // stdioEnv(), so this assertion is an honest claim about the whole suite.
  expect(snapshotDir(realOmsDir)).toBe(realOmsBefore);
  if (smokeHome) await rm(smokeHome, { recursive: true, force: true });
});

function textPayload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  const text = block.type === "text" ? block.text : "{}";
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error(text); }
}

async function connectInMemory(vault: string): Promise<{
  readonly server: ReturnType<typeof createOMSMcpServer>;
  readonly client: Client;
}> {
  const server = createOMSMcpServer({ vault, source: "explicit" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "oms-mcp-template-guard-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

describe("Oh My Second Brain MCP stdio server", () => {
  it("advertises query defaults that match the SearchBackend contract", () => {
    const search = omsMcpTools.find((tool) => tool.name === "search");
    const schema = search?.inputSchema as {
      readonly oneOf?: readonly {
        readonly properties?: Record<string, { readonly const?: string; readonly default?: unknown }>;
      }[];
    };
    const query = schema.oneOf?.find(
      (operation) => operation.properties?.["op"]?.const === "query",
    );

    expect(query?.properties?.["limit"]?.default).toBe(10);
    expect(query?.properties?.["minScore"]?.default).toBe(0);
    expect(query?.properties?.["rerank"]?.default).toBe(false);
    const operationNames = schema.oneOf
      ?.map((operation) => operation.properties?.["op"]?.const)
      .filter((operation): operation is string => typeof operation === "string");
    expect(operationNames).toEqual(expect.arrayContaining(["context", "templates", "query", "index-status", "get-document"]));
    for (const removed of ["lazy-load", "multi-get-documents", "collections", "contexts", "status"]) {
      expect(operationNames).not.toContain(removed);
    }
    for (const retired of ["axis", "semantic-query", "semantic-collections", "semantic-contexts", "semantic-status"]) {
      expect(operationNames).not.toContain(retired);
    }
  });

  it("projects branch fields onto tools/list properties without weakening oneOf", () => {
    const validator = new AjvJsonSchemaValidator();
    const tools = new Map(omsMcpTools.map((tool) => [tool.name, tool]));
    const expectedOps: Record<string, readonly string[]> = {
      search: ["context", "templates", "query", "index-status", "get-document"],
      link: ["suggest", "check"],
      status: ["graph"],
      doctor: ["audit", "validate", "build-graph", "cleanup", "sync-embeddings"],
    };

    expect([...tools.keys()].sort()).toEqual(["doctor", "link", "search", "status", "write"]);
    for (const [name, ops] of Object.entries(expectedOps)) {
      const schema = tools.get(name)?.inputSchema as {
        readonly properties?: Record<string, { readonly enum?: readonly string[]; readonly type?: string; readonly anyOf?: readonly unknown[] }>;
        readonly required?: readonly string[];
        readonly oneOf?: readonly {
          readonly additionalProperties?: false;
          readonly properties?: Record<string, { readonly const?: string }>;
          readonly required?: readonly string[];
        }[];
      };
      const op = schema.properties?.["op"];
      expect(op?.enum, name).toEqual([...ops]);
      expect(schema.required ?? [], name).toEqual(name === "status" ? [] : ["op"]);
      for (const branch of schema.oneOf ?? []) {
        expect(branch.additionalProperties, name).toBe(false);
      }
      const branchOps = [...new Set((schema.oneOf ?? [])
        .map((branch) => branch.properties?.["op"]?.const)
        .filter((value): value is string => typeof value === "string"))];
      expect(branchOps, name).toEqual([...ops]);
    }

    const searchSchema = tools.get("search")!.inputSchema as {
      readonly properties: Record<string, { readonly type?: string; readonly default?: unknown; readonly anyOf?: readonly unknown[] }>;
    };
    expect(searchSchema.properties["query"]).toEqual({ type: "string" });
    expect(searchSchema.properties["limit"]).toEqual({
      anyOf: [
        { type: "integer", minimum: 0 },
        { type: "integer", minimum: 0, default: 10 },
      ],
    });
    expect(searchSchema.properties["axes"]).toMatchObject({
      type: "object",
      properties: { template: { type: "string" }, folder: expect.any(Object), field: expect.any(Object), link: expect.any(Object) },
    });
    // write is one direct payload, not an op-dispatched tool.
    expect(tools.get("write")!.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" }, content: { type: "string" }, template: { type: "string" } },
      required: ["path", "content"],
    });

    const write = validator.getValidator(tools.get("write")!.inputSchema);
    const search = validator.getValidator(tools.get("search")!.inputSchema);
    const doctor = validator.getValidator(tools.get("doctor")!.inputSchema);
    const status = validator.getValidator(tools.get("status")!.inputSchema);
    const digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    expect(search({ op: "query", query: "architecture", limit: 10, axes: { template: "literature" } }).valid).toBe(true);
    expect(search({ op: "query", limit: 10 }).valid).toBe(false);
    expect(search({ op: "guide", notePath: "notes/a.md" }).valid).toBe(false);
    expect(write({ path: "notes/a.md", content: "x" }).valid).toBe(true);
    expect(write({ path: "notes/a.md", content: "x", template: "literature" }).valid).toBe(true);
    expect(write({ op: "guide", notePath: "notes/a.md" }).valid).toBe(false);
    expect(write({ op: "check", connectionId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222" }).valid).toBe(false);
    expect(write({ op: "complete", checkpoint: { schemaVersion: 1 }, review: {} }).valid).toBe(false);
    // Every retired template payload is refused by the schema itself.
    for (const payload of [
      { op: "template", mode: "interview-answer", questionId: digest, answer: "required", censusDigest: digest, expectedLedgerDigest: null },
      { op: "template", mode: "commit-contracts", censusDigest: digest, expectedLedgerDigest: null, dryRun: true },
      { op: "template", mode: "acknowledge-source", templateId: "literature", reviewedDigest: digest, transactionId: "33333333-3333-4333-8333-333333333333", confirmed: true },
      { op: "template", mode: "relink-source", templateId: "literature", candidatePath: "Templates/moved.md", transactionId: "33333333-3333-4333-8333-333333333333" },
    ]) {
      expect(write(payload).valid, JSON.stringify(payload)).toBe(false);
    }
    // The derived-projection repair is retired, so no branch accepts it.
    expect(doctor({ op: "regenerate-types", dryRun: true }).valid).toBe(false);
    expect(doctor({ op: "regenerate-types", dryRun: false, approvedDigest: digest }).valid).toBe(false);
    expect(status({}).valid).toBe(true);
    expect(status({ op: "graph", extra: true }).valid).toBe(false);
  });

  it("keeps query budget schemas aligned with the runtime contract", () => {
    const validator = new AjvJsonSchemaValidator();
    const search = omsMcpTools.find((tool) => tool.name === "search");
    const validate = validator.getValidator(search!.inputSchema);

    expect(validate({ op: "query", mode: "query", query: "architecture", limit: 0, candidateLimit: 1 }).valid).toBe(true);
    expect(validate({ op: "query", query: "architecture" }).valid).toBe(true);
    expect(validate({ op: "query", query: "", lex: "architecture" }).valid).toBe(true);
    expect(validate({ op: "query", mode: "query", query: "", lex: "architecture" }).valid).toBe(false);
    expect(validate({ op: "query", mode: "query", query: "architecture", limit: 1.5 }).valid).toBe(false);
    expect(validate({ op: "query", mode: "query", query: "architecture", candidateLimit: 0 }).valid).toBe(false);
    expect(validate({ op: "query", mode: "query", query: "architecture", candidateLimit: 1.5 }).valid).toBe(false);
    expect(validate({
      op: "query",
      mode: "query",
      query: "architecture",
      strategy: { kind: "expand", profile: "qmd-v2.8.3", maxQueries: 32 },
    }).valid).toBe(true);
    expect(validate({
      op: "query",
      mode: "query",
      query: "architecture",
      strategy: { kind: "expand", profile: "qmd-v2.8.3", maxQueries: 0 },
    }).valid).toBe(false);
    expect(validate({
      op: "query",
      mode: "query",
      query: "architecture",
      strategy: { kind: "expand", profile: "qmd-v2.8.3", maxQueries: 1.5 },
    }).valid).toBe(false);

    const schema = search!.inputSchema as {
      readonly oneOf?: readonly {
        readonly properties?: Record<string, unknown>;
      }[];
    };
    const context = schema.oneOf?.find((operation) =>
      (operation.properties?.["op"] as { readonly const?: unknown } | undefined)?.const === "context",
    );
    expect(context?.properties).not.toHaveProperty("semanticStrategy");
  });

  it("fails loudly for retired semantic-query and axis operation names", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp", "--vault", fixtureVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-query-surface-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      for (const op of ["semantic-query", "axis"]) {
        const result = await client.callTool({ name: "search", arguments: { op, query: "architecture" } });
        expect(result.isError, op).toBe(true);
        const message = result.content[0]?.type === "text" ? result.content[0].text : "";
        expect(message).toContain(`Unknown operation "${op}"`);
      }
    } finally {
      await client.close();
    }
  });

  it("guides unavailable semantic indexes to the canonical index sync command", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp", "--vault", fixtureVault],
      cwd: repoRoot,
      env: stdioEnv({ OMS_EMBEDDING_PROVIDER: undefined, OMS_EMBEDDING_MODEL: undefined }),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-index-guidance-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "search", arguments: { op: "index-status", view: "collections" } });
      const payload = textPayload(result);
      expect(payload.available).toBe(false);
      const message = typeof payload.reason === "string" ? payload.reason : "";
      expect(message).toContain("oms index sync");
      expect(message).not.toContain("oms semantic sync");
    } finally {
      await client.close();
    }
  });

  it("keeps every tool-declaring skill's MCP arguments valid for its advertised schema", async () => {
    const validator = new AjvJsonSchemaValidator();
    const toolByName = new Map(omsMcpTools.map((tool) => [tool.name, tool]));
    const skillRoot = path.join(repoRoot, "assets", "skills");
    const skillDirs = await readdir(skillRoot, { withFileTypes: true });
    const declaredSkills = await Promise.all(
      skillDirs.filter((entry) => entry.isDirectory()).map(async (entry) => {
        const document = await readFile(path.join(skillRoot, entry.name, "SKILL.md"), "utf-8");
        const frontmatter = parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(document)?.[1] ?? "") as Record<string, unknown>;
        return { skill: entry.name, frontmatter };
      }),
    );
    const skillsWithTools = declaredSkills.filter(({ frontmatter }) => typeof frontmatter["mcp_tool"] === "string");
    expect(skillsWithTools).toHaveLength(5);
    for (const { skill, frontmatter } of skillsWithTools) {
      const tool = toolByName.get(frontmatter["mcp_tool"] as string);
      expect(tool, `${skill} declares an advertised MCP tool`).toBeDefined();
      expect(validator.getValidator(tool!.inputSchema)(frontmatter["mcp_args"]).valid, skill).toBe(true);

      const schema = tool!.inputSchema as {
        readonly oneOf?: readonly {
          readonly properties?: Record<string, { readonly const?: unknown }>;
        }[];
      };
      const operation = (frontmatter["mcp_args"] as Record<string, unknown>)["op"];
      const declaredOperations = (schema.oneOf ?? [])
        .map((branch) => branch.properties?.["op"]?.const)
        .filter((value): value is string => typeof value === "string");
      const acceptsZeroArguments = (schema.oneOf ?? []).some(branch =>
        Object.keys(branch.properties ?? {}).length === 0
      );
      if (schema.oneOf === undefined || (acceptsZeroArguments && operation === undefined)) {
        expect(operation, `${skill} must not declare an op for a direct tool`).toBeUndefined();
      } else {
        expect(typeof operation, `${skill}.mcp_args.op must be a string`).toBe("string");
        expect(declaredOperations, `${skill}.mcp_args.op must match its tool operation`).toContain(operation);
      }
    }
  });

  it("advertises containsAll and between field predicates with strict tuple shapes", () => {
    const validator = new AjvJsonSchemaValidator();
    const search = omsMcpTools.find((tool) => tool.name === "search");
    const schema = search?.inputSchema;
    const validate = validator.getValidator(schema!);

    expect(validate({
      op: "query",
      mode: "query",
      query: "typed axes",
      axes: {
        field: {
          tags: { containsAll: ["one", "two"] },
          score: { between: [1, 10] },
        },
      },
    }).valid).toBe(true);
    expect(validate({
      op: "query",
      mode: "query",
      query: "typed axes",
      axes: { field: { tags: { containsAll: "one" } } },
    }).valid).toBe(false);
    expect(validate({
      op: "query",
      mode: "query",
      query: "typed axes",
      axes: { field: { score: { between: [1] } } },
    }).valid).toBe(false);
    expect(validate({
      op: "query",
      mode: "query",
      query: "typed axes",
      axes: { field: { score: { between: [1, 10, 20] } } },
    }).valid).toBe(false);
  });

  it("advertises the approved write payload and zero-argument status contract", () => {
    const validator = new AjvJsonSchemaValidator();
    const toolByName = new Map(omsMcpTools.map((tool) => [tool.name, tool]));
    const write = validator.getValidator(toolByName.get("write")!.inputSchema);
    const search = validator.getValidator(toolByName.get("search")!.inputSchema);
    const doctor = validator.getValidator(toolByName.get("doctor")!.inputSchema);
    const status = validator.getValidator(toolByName.get("status")!.inputSchema);

    // One write payload: the note bytes, where they go, and an optional template.
    expect(write({ path: "references/a.md", content: "x" }).valid).toBe(true);
    expect(write({ path: "references/a.md", content: "x", template: "literature" }).valid).toBe(true);
    expect(write({ path: "references/a.md", content: "x", template: null }).valid).toBe(false);
    expect(write({ path: "references/a.md" }).valid).toBe(false);
    expect(write({ op: "guide", notePath: "references/a.md", templateId: "literature" }).valid).toBe(false);
    expect(write({ op: "check", connectionId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222" }).valid).toBe(false);
    expect(write({ op: "complete", checkpoint: { schemaVersion: 1 }, review: {} }).valid).toBe(false);
    expect(write({ op: "note", mode: "create", body: "Retired." }).valid).toBe(false);
    expect(status({}).valid).toBe(true);
    expect(status({ op: "graph" }).valid).toBe(true);
    expect(status({ op: "status" }).valid).toBe(false);
    expect(search({ op: "templates" }).valid).toBe(true);
    expect(search({ op: "templates", templateId: "literature" }).valid).toBe(false);
    expect(search({ op: "template-scan" }).valid).toBe(false);
    expect(search({ op: "get-document", target: "notes/a.md" }).valid).toBe(true);
    expect(search({ op: "get-document", targets: ["notes/a.md"] }).valid).toBe(true);
    expect(search({ op: "get-document", notePath: "notes/a.md", fromLine: 1, lineCount: 20 }).valid).toBe(true);
    expect(search({ op: "get-document", target: "notes/a.md", targets: ["notes/a.md"] }).valid).toBe(false);
    expect(search({ op: "lazy-load", notePath: "notes/a.md" }).valid).toBe(false);
    expect(search({ op: "multi-get-documents", targets: ["notes/a.md"] }).valid).toBe(false);
    expect(search({ op: "index-status", view: "status" }).valid).toBe(true);
    expect(search({ op: "collections" }).valid).toBe(false);
    expect(doctor({ op: "sync-embeddings", mode: "sync" }).valid).toBe(true);
    expect(doctor({ op: "sync-embeddings", mode: "embed" }).valid).toBe(true);
    expect(doctor({ op: "sync-embeddings", mode: "repair" }).valid).toBe(false);
    expect(doctor({ op: "sync-embeddings", mode: "repair", repairMode: "rebuild" }).valid).toBe(true);
    expect(doctor({ op: "sync-embeddings", mode: "repair", repairMode: "drop", dryRun: true }).valid).toBe(true);
    expect(doctor({ op: "sync-embeddings", mode: "repair", repairMode: "vacuum" }).valid).toBe(false);
    expect(doctor({ op: "sync-embeddings", mode: "sync", repairMode: "drop" }).valid).toBe(false);
    expect(doctor({ op: "sync-embeddings", mode: "embed", dryRun: true }).valid).toBe(false);
    expect(doctor({ op: "sync-embeddings", mode: "sync", embed: false }).valid).toBe(false);
    // Every template mutation and source-review payload is outside the write schema.
    const digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const transactionId = "33333333-3333-4333-8333-333333333333";
    for (const payload of [
      { op: "template", transactionId: "tx-resume", approvedDigest: digest },
      { op: "template", mode: "publish-contract", policy: { version: 5 }, transactionId, confirmed: true },
      { op: "template", mode: "regenerate", dryRun: true },
      { op: "template", mode: "interview-next" },
      { op: "template", mode: "commit-contracts", censusDigest: digest, expectedLedgerDigest: null, dryRun: true },
      { op: "template", mode: "review-sources" },
      { op: "template", mode: "acknowledge-source", templateId: "literature", reviewedDigest: digest, transactionId, confirmed: true },
      { op: "template", mode: "relink-source", templateId: "literature", candidatePath: "Templates/moved.md", transactionId },
    ]) {
      expect(write(payload).valid, JSON.stringify(payload)).toBe(false);
    }
    expect(JSON.stringify(toolByName.get("search")!.inputSchema)).not.toContain("concept");
  });

  it("refuses every retired template mutation without touching a control", async () => {
    const tmpVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-mcp-template-guards-")));
    await createMcpMetadataAuthority(tmpVault);
    const controlledPaths = [
      ".oms/settings.json",
      ".obsidian/types.json",
      "Templates/article.md",
    ] as const;
    const before = await Promise.all(controlledPaths.map(relative => readFile(path.join(tmpVault, relative))));
    const { server, client } = await connectInMemory(tmpVault);
    try {
      for (const mode of ["regenerate", "create", "update", "remove", "default", "register-folder", "interview-next", "review-sources"]) {
        const refused = await client.callTool({
          name: "write",
          arguments: { op: "template", mode, dryRun: true },
        });
        expect(refused.isError, mode).toBe(true);
        const payload = textPayload(refused);
        expect(payload.ok, mode).toBe(false);
        expect(payload.violations, mode).toEqual(expect.arrayContaining([{ field: "op", kind: "unsupported-input" }]));
      }
      expect(await Promise.all(controlledPaths.map(relative => readFile(path.join(tmpVault, relative))))).toEqual(before);
    } finally {
      await client.close();
      await server.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("exposes read/status tools and validates a fixture note", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp", "--vault", fixtureVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toEqual(["write", "search", "link", "status", "doctor"]);
      expect(names).toEqual(harnessSurfaceRegistry.mcpTools.map((tool) => tool.name));
      for (const registryTool of harnessSurfaceRegistry.mcpTools) {
        const tool = tools.tools.find((candidate) => candidate.name === registryTool.name);
        expect(tool, registryTool.name).toBeDefined();
        expect(tool?.annotations?.readOnlyHint).toBe(registryTool.posture === "read");
        expect(tool?.annotations?.destructiveHint).toBe(registryTool.destructive);
        expect(tool?.annotations?.idempotentHint).toBe(registryTool.idempotent);
        expect(tool?.annotations?.openWorldHint).toBe(registryTool.openWorld);
      }
      const retrieveTool = tools.tools.find((tool) => tool.name === "search");
      expect(JSON.stringify(retrieveTool?.inputSchema)).toContain("semanticMinScore");
      // storage/modelPath knobs were removed from the schemas (engine uses explicit env config).
      expect(JSON.stringify(retrieveTool?.inputSchema)).not.toContain("semanticStorage");
      expect(JSON.stringify(retrieveTool?.inputSchema)).not.toContain("semanticModelPath");
      expect(retrieveTool?.annotations?.readOnlyHint).toBe(true);
      expect(JSON.stringify(retrieveTool?.inputSchema)).toContain('"query"');
      expect(JSON.stringify(retrieveTool?.inputSchema)).not.toContain("semantic-query");
      expect(JSON.stringify(retrieveTool?.inputSchema)).toContain("get-document");
      expect(JSON.stringify(retrieveTool?.inputSchema)).not.toContain("modelPath");
      expect(JSON.stringify(retrieveTool?.inputSchema)).not.toContain("concept");
      const doctorTool = tools.tools.find((tool) => tool.name === "doctor");
      expect(doctorTool?.annotations?.readOnlyHint).toBe(false);
      expect(JSON.stringify(doctorTool?.inputSchema)).toContain("audit");

      const status = await client.callTool({ name: "status", arguments: {} });
      const parsedStatus = textPayload(status);
      expect(parsedStatus.writeTools).toBe("write-gated-by-verified-target-and-contract");
      const writeTool = tools.tools.find((tool) => tool.name === "write");
      expect(writeTool?.annotations?.readOnlyHint).toBe(false);
      // The write tool is advertised with its one exact input shape; the judge refuses, not discovery.
      expect(writeTool?.inputSchema).toEqual({
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" }, template: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      });
      expect(parsedStatus.counts).toBeNull();
      expect(parsedStatus).not.toHaveProperty("projectionSource");
      expect(parsedStatus).not.toHaveProperty("derivedState");
      expect(parsedStatus.contract).toMatchObject({ contract: "none", templates: [] });

      const templateDiagnosis = textPayload(await client.callTool({
        name: "doctor",
        arguments: { op: "validate" },
      }));
      expect(templateDiagnosis).toMatchObject({ vault: fixtureVault, contract: "none", audience: "agent" });
      expect(templateDiagnosis.findings).toEqual(expect.any(Array));
      const audit = await client.callTool({
        name: "doctor",
        arguments: { op: "audit", folder: "references" },
      });
      const parsedAudit = textPayload(audit);
      expect(parsedAudit).toEqual({ vault: fixtureVault, folder: "references", contract: "none", scannedNotes: 1, clean: true, violations: [] });
      const nonStringFolderAudit = await client.callTool({
        name: "doctor",
        arguments: { op: "audit", folder: 123 },
      });
      expect(nonStringFolderAudit.isError).toBe(true);
      expect(nonStringFolderAudit.content[0]?.type === "text" ? nonStringFolderAudit.content[0].text : "").toContain(
        'Argument "folder" must be a string',
      );

      const missingVaultFolderAudit = textPayload(await client.callTool({
        name: "doctor",
        arguments: { op: "audit", folder: "inbox" },
      }));
      expect(missingVaultFolderAudit).toMatchObject({ folder: "inbox", contract: "none", scannedNotes: 0, violations: [] });
    } finally {
      await client.close();
    }
  });

  it("retrieves live graph context without requiring a warm cache or semantic backend", async () => {
    const tmpVault = await mkdtemp(path.join(tmpdir(), "oms-mcp-retrieve-"));
    // Retrieval reads the explicit contract, so this vault publishes V5.
    await writeContractVault(tmpVault, {
      contractStoreRoot: childStoreRoot(),
      properties: {
        title: { type: "text", intent: "Note title." },
        "source-url": { type: "text", intent: "Where the source came from." },
      },
      templates: {
        literature: { fields: ["title", "source-url"], approvedMarkdown: LITERATURE_MARKDOWN, targetFolder: "references" },
      },
      folders: { references: { intent: "Processed sources." } },
      obsidianTypes: { title: "text", "source-url": "text" },
    });
    await mkdir(path.join(tmpVault, "references"), { recursive: true });
    await writeFile(
      path.join(tmpVault, "references", "Agent Retrieval.md"),
      `---
template: literature
title: Agent Retrieval
source-url: https://example.com/agent-retrieval
---
Agent retrieval follows [[Graph Index]].
`,
      "utf-8",
    );
    await writeFile(
      path.join(tmpVault, "references", "Graph Index.md"),
      `---
template: literature
title: Graph Index
source-url: https://example.com/graph-index
---
Index note.
`,
      "utf-8",
    );
    await writeFile(
      path.join(tmpVault, "references", "Malformed.md"),
      `---
template: literature
title: Valid
source-url: https://example.com/valid
---
Valid frontmatter remains available to retrieve.
`,
      "utf-8",
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const result = textPayload(
        await client.callTool({
          name: "search",
          arguments: { op: "context",
            template: "literature",
            query: "agent retrieval graph",
            limit: 1,
            maxNeighbors: 5,
            useCache: false,
            semanticEnabled: false,
          },
        }),
      );

      expect(result.mode).toBe("oms-local-graph-semantic-fusion");
      const providers = result.providers as Record<string, unknown>;
      expect(providers.graph).toBe("headless-scan");
      expect(providers.semantic).toEqual({ available: false, reason: "disabled" });
      const hits = result.hits as Array<Record<string, unknown>>;
      expect(hits.map((hit) => hit.source)).toEqual(["oms-seed", "oms-neighbor"]);
      expect(hits.map((hit) => hit.path)).toContain("references/Graph Index.md");
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("refuses the retired guide shape on an open vault", async () => {
    const tmpVault = await mkdtemp(path.join(tmpdir(), "oms-open-"));

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const status = textPayload(await client.callTool({ name: "status", arguments: {} }));
      expect(status.writeTools).toBe("write-gated-by-verified-target-and-contract");
      expect(status.readTools).toEqual(["search", "link", "status"]);

      expect(status.contract).toMatchObject({ contract: "none", row: "never-sealed" });

      // The retired guide shape is refused key by key, never reinterpreted.
      const write = await client.callTool({
        name: "write",
        arguments: { op: "guide", notePath: "references/unsafe.md", templateId: "literature" },
      });
      expect(write.isError).toBe(true);
      expect(textPayload(write)).toMatchObject({
        ok: false,
        violations: [
          { field: "notePath", kind: "unsupported-input" },
          { field: "op", kind: "unsupported-input" },
          { field: "templateId", kind: "unsupported-input" },
        ],
      });
      expect(existsSync(path.join(tmpVault, "references", "unsafe.md"))).toBe(false);
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("keeps a cache-only .oms vault open", async () => {
    const tmpVault = await mkdtemp(path.join(tmpdir(), "oms-cache-only-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);
      expect(textPayload(await client.callTool({ name: "status", arguments: {} })).contract).toMatchObject({ contract: "none" });

      await client.callTool({ name: "doctor", arguments: { op: "build-graph",} });

      expect(textPayload(await client.callTool({ name: "status", arguments: {} })).contract).toMatchObject({ contract: "none" });
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("treats a non-directory .oms path as invalid instead of using bundled defaults", async () => {
    const tmpVault = await mkdtemp(path.join(tmpdir(), "oms-file-"));
    await writeFile(path.join(tmpVault, ".oms"), "not a directory", "utf-8");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const status = textPayload(await client.callTool({ name: "status", arguments: {} }));
      expect(status.contract).toMatchObject({ contract: "none" });

      const write = await client.callTool({
        name: "write",
        arguments: {
          notePath: "references/unsafe.md",
          frontmatter: {
            title: "Should not write",
            "source-url": "https://example.com/should-not-write",
          },
          body: "Should not write.",
          op: "note",
          mode: "create",
          templateId: "literature",
        },
      });
      expect(write.isError).toBe(true);
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("refuses a write that addresses the note two ways at once", async () => {
    const tmpVault = await mkdtemp(path.join(tmpdir(), "oms-mcp-write-ambig-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      // `notePath` and `folder`/`filename` are two spellings of the same
      // address. Silently preferring one produced a response reporting the
      // concept implied by one form and the folder implied by the other, which
      // reads as corruption rather than as the input error it is.
      const raw = await client.callTool({
        name: "write",
        arguments: {
          op: "note",
          mode: "create",
          templateId: "literature",
          notePath: "notes/x.md",
          folder: "notes",
          filename: "x.md",
          body: "Body",
        },
      });

      expect(raw.isError).toBe(true);
      expect(textPayload(raw)).toMatchObject({
        ok: false,
        violations: ["body", "filename", "folder", "mode", "notePath", "op", "templateId"].map(field => ({ field, kind: "unsupported-input" })),
      });
      expect(await readdir(tmpVault)).toEqual([]);
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("judges every write against the sealed contract and saves only an allowed note", async () => {
    const fixture = await buildTruthTableRow("sealed", SEALED_WRITE_CONTRACT);
    const vault = fixture.vault;
    await mkdir(path.join(vault, "Projects"), { recursive: true });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp", "--vault", vault],
      cwd: repoRoot,
      // The fixture's own home holds the sealed store; the real ~/.oms is never read.
      env: stdioEnv({ HOME: path.join(fixture.base, "home"), USERPROFILE: path.join(fixture.base, "home") }),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });
    const write = (args: Record<string, unknown>) => client.callTool({ name: "write", arguments: args });
    const note = path.join(vault, "Projects", "a.md");

    try {
      await client.connect(transport);

      // A new note that satisfies the selected template is saved world-readable.
      const created = await write({ path: "Projects/a.md", content: "---\nstatus: active\n---\n# Goals\n", template: "project" });
      expect(textPayload(created)).toEqual({ ok: true, path: "Projects/a.md", missingDefaults: [{ field: "owner" }] });
      expect(statSync(note).mode & 0o777).toBe(0o644);

      // A denied write names {field, kind} only and leaves the bytes untouched.
      await chmod(note, 0o600);
      const before = await readFile(note);
      const denied = await write({ path: "Projects/a.md", content: "---\nstatus: nope\n---\n# Goals\n" });
      expect(denied.isError).toBe(true);
      const deniedPayload = textPayload(denied);
      expect(deniedPayload).toMatchObject({ ok: false, violations: [{ field: "status", kind: "not-allowed" }] });
      expect(typeof deniedPayload.reason).toBe("string");
      expect(JSON.stringify(deniedPayload)).not.toContain("active");
      expect(JSON.stringify(deniedPayload)).not.toContain(fixture.vaultId);
      expect(await readFile(note)).toEqual(before);

      const headingless = await write({ path: "Projects/a.md", content: "---\nstatus: done\n---\nBody\n", template: "project" });
      expect(textPayload(headingless)).toMatchObject({ ok: false, violations: [{ field: "Goals", kind: "heading-missing" }] });
      expect(await readFile(note)).toEqual(before);

      // An allowed overwrite keeps the note's previous mode and leaves no temporary file.
      const updated = await write({ path: "Projects/a.md", content: "---\nstatus: done\n---\n# Goals\n" });
      expect(textPayload(updated)).toEqual({ ok: true, path: "Projects/a.md", missingDefaults: [{ field: "owner" }] });
      expect(await readFile(note, "utf8")).toBe("---\nstatus: done\n---\n# Goals\n");
      expect(statSync(note).mode & 0o777).toBe(0o600);
      expect(await readdir(path.join(vault, "Projects"))).toEqual(["a.md"]);

      expect(textPayload(await write({ path: "Projects/a.md", content: "x", templateId: "project" }))).toMatchObject({
        ok: false, violations: [{ field: "templateId", kind: "unsupported-input" }],
      });
      expect(textPayload(await write({ content: "x" }))).toMatchObject({ ok: false, violations: [{ field: "path", kind: "missing" }] });
      expect(textPayload(await write({ path: "Projects/b.md" }))).toMatchObject({ ok: false, violations: [{ field: "content", kind: "missing" }] });
      expect(textPayload(await write({ path: "../outside.md", content: "x" }))).toMatchObject({ ok: false, violations: [{ kind: "outside-vault" }] });
      expect(existsSync(path.join(fixture.base, "outside.md"))).toBe(false);
      const settings = await readFile(path.join(vault, ".oms", "settings.json"));
      expect(textPayload(await write({ path: ".oms/settings.json", content: "{}" }))).toMatchObject({ ok: false, violations: [{ kind: "control-path" }] });
      expect(await readFile(path.join(vault, ".oms", "settings.json"))).toEqual(settings);
      expect(await readdir(path.join(vault, "Projects"))).toEqual(["a.md"]);
    } finally {
      await client.close();
      await fixture.cleanup();
    }
  });

  it("suggests term links and checks them without ever editing the note", async () => {
    const tmpVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-mcp-linkify-")));
    await createLinkTemplateAuthority(tmpVault);
    await mkdir(path.join(tmpVault, "terms"), { recursive: true });
    await mkdir(path.join(tmpVault, "notes"), { recursive: true });
    await writeFile(
      path.join(tmpVault, "terms", "Ataraxia.md"),
      "---\ntemplate: note\ntitle: Ataraxia\naliases:\n  - 아타락시아\n---\n\nFreedom from disturbance.\n",
      "utf-8",
    );
    await writeFile(
      path.join(tmpVault, "terms", "Stoicism.md"),
      "---\ntemplate: note\ntitle: Stoicism\n---\n\nA school of thought.\n",
      "utf-8",
    );
    const notePath = "notes/sage.md";
    const noteFile = path.join(tmpVault, "notes", "sage.md");
    const body = "---\ntemplate: note\ntitle: Sage\n---\n\nThe sage pursues Ataraxia through Stoicism.\n아타락시아를 향한 길.\nSee [[Missing Term]].\n";
    await writeFile(noteFile, body, "utf-8");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const suggested = textPayload(await client.callTool({
        name: "link",
        arguments: { op: "suggest", notePath },
      }));
      const candidates = suggested.candidates as { readonly id: string; readonly targetPath: string }[];
      expect(candidates.map(candidate => candidate.targetPath)).toEqual(
        expect.arrayContaining(["terms/Ataraxia.md", "terms/Stoicism.md"]),
      );
      expect(suggested.baseContentHash).toMatch(/^[0-9a-f]{64}$/u);

      const checked = textPayload(await client.callTool({
        name: "link",
        arguments: { op: "check", notePath },
      }));
      expect(checked.unresolved).toEqual(["Missing Term"]);

      // Applying an edit is the agent's job; both operations are read-only.
      expect(await readFile(noteFile, "utf-8")).toBe(body);
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("rejects malformed link-tool arguments without touching the vault", async () => {
    // Given: a vault with one note
    const tmpVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-mcp-linkify-bad-")));
    await mkdir(path.join(tmpVault, "notes"), { recursive: true });
    await writeFile(path.join(tmpVault, "notes", "sage.md"), "---\ntitle: Sage\n---\n\nBody.\n", "utf-8");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      // When: notePath is omitted
      const missing = await client.callTool({ name: "link", arguments: { op: "suggest",} });
      // Then: the tool reports a typed argument error
      expect(missing.isError).toBe(true);
      expect(missing.content[0]?.type === "text" ? missing.content[0].text : "").toContain("notePath");

      // When: the note does not exist
      const absent = await client.callTool({
        name: "link",
        arguments: { op: "suggest", notePath: "notes/does-not-exist.md" },
      });
      // Then: the tool errors instead of inventing an empty suggestion set
      expect(absent.isError).toBe(true);

      // When: check omits the note path
      const noPath = await client.callTool({ name: "link", arguments: { op: "check" } });
      // Then: the tool refuses with a typed argument error
      expect(noPath.isError).toBe(true);
      expect(noPath.content[0]?.type === "text" ? noPath.content[0].text : "").toContain("notePath");

      // The retired apply operation is not reachable at all.
      const apply = await client.callTool({
        name: "link",
        arguments: { op: "apply", notePath: "notes/sage.md", baseContentHash: "0".repeat(64), candidateIds: [] },
      });
      expect(apply.content[0]?.type === "text" ? apply.content[0].text : "").toContain("Unknown operation");
      expect(await readFile(path.join(tmpVault, "notes", "sage.md"), "utf-8")).toBe("---\ntitle: Sage\n---\n\nBody.\n");
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("rejects writes and reports an unverified posture when the target came from cwd", async () => {
    // No --vault, a non-vault cwd, no bridge, and no OMS_VAULT: resolution
    // falls all the way through to the `cwd` source, which is unverified for
    // the write surface (issue #58).
    const tmpHome = await mkdtemp(path.join(tmpdir(), "oms-mcp-cwd-home-"));
    // realpath: a spawned process reports the canonical cwd (macOS /tmp is a symlink),
    // and the server resolves its target from that cwd.
    const tmpCwd = await realpath(await mkdtemp(path.join(tmpdir(), "oms-mcp-cwd-")));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp"],
      cwd: tmpCwd,
      env: { HOME: tmpHome, PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const status = textPayload(await client.callTool({ name: "status", arguments: {} }));
      expect(status.writeTools).toBe("write-disabled-target-unverified");

      const write = textPayload(
        await client.callTool({
          name: "write",
          arguments: { path: "references/misrouted.md", content: "# Misrouted\n" },
        }),
      );
      expect(write).toMatchObject({ ok: false, status: "rejected", rejection: { stage: "admission", code: "target-unverified" } });
      expect((write.rejection as Record<string, string>).message).toContain("current directory");

      // Link is read-only, so an unverified target changes nothing about it:
      // there is no apply to reject, and the booting directory stays empty.
      const linkApply = await client.callTool({ name: "link", arguments: { op: "apply", notePath: "notes/misrouted.md", baseContentHash: "0".repeat(64), candidateIds: [] } });
      expect(linkApply.content[0]?.type === "text" ? linkApply.content[0].text : "").toContain("Unknown operation");
      expect(await readdir(tmpCwd)).toEqual([]);
    } finally {
      await client.close();
      await rm(tmpCwd, { recursive: true, force: true });
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("rejects doctor repairs but permits diagnosis when the target came from cwd", async () => {
    const tmpHome = await mkdtemp(path.join(tmpdir(), "oms-mcp-doctor-cwd-home-"));
    const tmpCwd = await realpath(await mkdtemp(path.join(tmpdir(), "oms-mcp-doctor-cwd-")));
    await mkdir(path.join(tmpCwd, "notes"), { recursive: true });
    await writeFile(path.join(tmpCwd, "notes", "unbound.md"), "# Unbound\n", "utf-8");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp"],
      cwd: tmpCwd,
      env: { HOME: tmpHome, PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      for (const [op, arguments_] of [
        ["build-graph", { op: "build-graph" }],
        ["cleanup", { op: "cleanup" }],
        ["sync-embeddings", { op: "sync-embeddings", mode: "sync" }],
        ["repair-index", { op: "sync-embeddings", mode: "repair", repairMode: "drop" }],
      ] as const) {
        const repair = textPayload(await client.callTool({ name: "doctor", arguments: arguments_ }));
        expect(repair).toMatchObject({
          status: "rejected",
          rejection: {
            stage: "admission",
            code: "target-unverified",
            recoverable: true,
          },
          resolvedVault: tmpCwd,
          resolutionSource: "cwd",
        });
        expect(repair.receipt).toBeUndefined();
      }

      // Diagnosis stays available and read-only: an unsealed vault is judged open.
      const audit = textPayload(await client.callTool({ name: "doctor", arguments: { op: "audit" } }));
      expect(audit).toEqual({ vault: tmpCwd, folder: null, contract: "none", scannedNotes: 1, clean: true, violations: [] });
      const templateDiagnosis = textPayload(
        await client.callTool({ name: "doctor", arguments: { op: "validate" } }),
      );
      expect(templateDiagnosis).toMatchObject({ vault: tmpCwd, contract: "none", row: "never-sealed", audience: "agent" });
      expect(await readdir(tmpCwd)).toEqual(["notes"]);
    } finally {
      await client.close();
      await rm(tmpCwd, { recursive: true, force: true });
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("returns a server-verified graph repair receipt for a verified target", async () => {
    const tmpVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-mcp-doctor-vault-")));
    await createMcpContractAuthority(tmpVault);
    await mkdir(path.join(tmpVault, "notes"), { recursive: true });
    await writeFile(path.join(tmpVault, "notes", "graph-note.md"), "---\ntemplate: literature\ntitle: Graph Note\nsource-url: https://example.com/graph-note\n---\nGraph note.\n", "utf-8");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp"],
      cwd: tmpVault,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);
      const repair = textPayload(
        await client.callTool({ name: "doctor", arguments: { op: "build-graph" } }),
      );
      const receipt = repair.receipt as Record<string, unknown>;
      const postcondition = receipt.postcondition as Record<string, unknown>;
      expect(repair).toMatchObject({ vault: tmpVault, resolvedVault: tmpVault, resolutionSource: "vault", notes: 1 });
      expect(receipt.resolvedVault).toBe(tmpVault);
      expect(receipt.resolutionSource).toBe("vault");
      expect(postcondition.kind).toBe("template-graph-cache");
      const cachePaths = postcondition.cachePaths as string[];
      expect(cachePaths).toHaveLength(2);
      for (const cachePath of cachePaths) expect((await readFile(cachePath)).byteLength).toBeGreaterThan(0);
      expect(postcondition.notes).toBe(1);
      expect(postcondition.edges).toBe(0);
      expect((receipt.written as Record<string, unknown>).paths).toEqual(cachePaths);
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("emits a type-affinity cap warning through the build-graph MCP response", async () => {
    const tmpVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-mcp-graph-cap-")));
    await writeContractVault(tmpVault, {
      contractStoreRoot: childStoreRoot(),
      properties: {
        title: { type: "text", intent: "Note title." },
        "source-url": { type: "text", intent: "Where the source came from." },
      },
      templates: {
        literature: { fields: ["title", "source-url"], approvedMarkdown: LITERATURE_MARKDOWN, targetFolder: "references" },
      },
      folders: { references: { intent: "Processed sources." } },
      obsidianTypes: { title: "text", "source-url": "text" },
    });
    await mkdir(path.join(tmpVault, "notes"), { recursive: true });
    await Promise.all(Array.from({ length: 65 }, (_, index) =>
      writeFile(
        path.join(tmpVault, "notes", `cap-${index}.md`),
        `---\ntemplate: literature\ntitle: Cap ${index}\nsource-url: https://example.com/cap-${index}\n---\nCap note.\n`,
        "utf-8",
      ),
    ));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp"],
      cwd: tmpVault,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);
      const result = textPayload(await client.callTool({ name: "doctor", arguments: { op: "build-graph" } }));
      expect(result.edges).toBe(0);
      expect(result.warnings).toEqual([
        'Skipped type-affinity edges for template "literature": 65 notes exceeds the 64-note limit.',
      ]);
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("returns a server-verified semantic sync receipt for a verified target", async () => {
    const tmpVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-mcp-doctor-sync-")));
    await mkdir(path.join(tmpVault, ".oms"), { recursive: true });
    await writeFile(path.join(tmpVault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: randomUUID() }), "utf-8");
    await writeFile(path.join(tmpVault, "note.md"), "# Indexed note\n", "utf-8");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp"],
      cwd: tmpVault,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);
      const repair = textPayload(
        await client.callTool({ name: "doctor", arguments: { op: "sync-embeddings", mode: "sync" } }),
      );
      const receipt = repair.receipt as Record<string, unknown>;
      const postcondition = receipt.postcondition as Record<string, unknown>;
      expect(receipt).toMatchObject({
        operation: "sync-embeddings",
        resolvedVault: tmpVault,
        resolutionSource: "vault",
      });
      expect(postcondition.kind).toBe("semantic-index");
      const database = new Database(postcondition.databasePath as string, { readonly: true });
      try {
        const documentPaths = (database
          .prepare("SELECT DISTINCT doc_path FROM engine_chunk_meta ORDER BY doc_path")
          .all() as { doc_path: string }[])
          .map((row) => row.doc_path);
        const chunks = (database.prepare("SELECT COUNT(*) AS count FROM engine_chunk_meta").get() as { count: number }).count;
        expect(postcondition.documentPaths).toEqual(documentPaths);
        expect(postcondition.chunks).toBe(chunks);
        expect(documentPaths).toEqual(["note.md"]);
        expect((receipt.written as Record<string, unknown>).paths).toEqual([postcondition.databasePath]);
      } finally {
        database.close();
      }
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("returns a server-verified semantic cleanup receipt for a verified target", async () => {
    const tmpVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-mcp-doctor-cleanup-")));
    await mkdir(path.join(tmpVault, ".oms"), { recursive: true });
    await writeFile(path.join(tmpVault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: randomUUID() }), "utf-8");
    await writeFile(path.join(tmpVault, "removed.md"), "# Removed note\n", "utf-8");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp"],
      cwd: tmpVault,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);
      textPayload(
        await client.callTool({ name: "doctor", arguments: { op: "sync-embeddings", mode: "sync" } }),
      );
      await rm(path.join(tmpVault, "removed.md"));
      const repair = textPayload(
        await client.callTool({ name: "doctor", arguments: { op: "cleanup" } }),
      );
      const receipt = repair.receipt as Record<string, unknown>;
      const postcondition = receipt.postcondition as Record<string, unknown>;
      expect(receipt).toMatchObject({
        operation: "semantic-cleanup",
        resolvedVault: tmpVault,
        resolutionSource: "vault",
      });
      expect(postcondition.kind).toBe("semantic-index");
      expect(postcondition.orphanDocumentPaths).toEqual([]);
      const database = new Database(postcondition.databasePath as string, { readonly: true });
      try {
        const documentPaths = (database
          .prepare("SELECT DISTINCT doc_path FROM engine_chunk_meta ORDER BY doc_path")
          .all() as { doc_path: string }[])
          .map((row) => row.doc_path);
        expect(documentPaths).toEqual(postcondition.documentPaths);
        expect(documentPaths).not.toContain("removed.md");
        expect((receipt.written as Record<string, unknown>).paths).toEqual([postcondition.databasePath]);
      } finally {
        database.close();
      }
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("keeps writing normally when `oms mcp` boots inside a real vault", async () => {
    // Regression guard: local `.oms` resolution (source "vault") stays a trusted
    // write target even though `cwd` resolution is now rejected.
    const tmpHome = await realpath(await mkdtemp(path.join(tmpdir(), "oms-mcp-vault-home-")));
    const tmpVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-mcp-local-vault-")));
    await createMcpContractAuthority(tmpVault, path.join(tmpHome, ".oms", "vaults"));

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp"],
      cwd: tmpVault,
      env: { HOME: tmpHome, PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const status = textPayload(await client.callTool({ name: "status", arguments: {} }));
      expect(status.writeTools).toBe("write-gated-by-verified-target-and-contract");
      expect(status.history).toEqual(expect.objectContaining({ verifications: expect.any(Number) }));
      const graph = textPayload(await client.callTool({ name: "status", arguments: { op: "graph" } }));
      expect(graph).toEqual(expect.objectContaining({ available: expect.any(Boolean) }));
      expect(graph).not.toHaveProperty("writeTools");
      expect(graph).not.toHaveProperty("derivedState");

      const listed = textPayload(await client.callTool({ name: "search", arguments: { op: "templates" } }));
      expect(listed.history).toEqual(expect.objectContaining({
        uses: 0,
        templates: expect.objectContaining({ literature: expect.objectContaining({ uses: 0, lastUsedAt: null }) }),
      }));

      // A vault-resolved target is verified, so the write is judged and saved.
      const saved = textPayload(await client.callTool({
        name: "write",
        arguments: {
          path: "references/local-vault-note.md",
          content: "---\ntitle: Local Vault Note\nsource-url: https://example.com/local-vault-note\n---\n\n# Literature\n",
        },
      }));
      expect(saved).toEqual({ ok: true, path: "references/local-vault-note.md", missingDefaults: [] });
      expect(await readdir(path.join(tmpVault, "references"))).toEqual(["local-vault-note.md"]);
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
      await rm(tmpHome, { recursive: true, force: true });
    }
  });
});
