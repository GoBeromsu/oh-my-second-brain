import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { parse } from "yaml";
import { harnessSurfaceRegistry } from "../kernel/harness/surface-registry.js";
import { omsMcpTools } from "./server.js";
import { sourceSignature } from "../kernel/templates/index.js";
import type { SourceDescriptor } from "../kernel/templates/types.js";

function templateDigest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function createMcpTemplateAuthority(vault: string): Promise<void> {
  const policy = JSON.stringify({ version: 1, templateFolder: "Templates/OMS", base: { fields: {} }, contracts: { literature: { intent: "A source.", fields: { template: { type: "text", required: true }, title: { type: "text", required: true }, "source-url": { type: "text", required: true } }, views: [] } }, templates: { literature: { templateId: "literature", destinationClass: "managed-default", sourcePath: "Templates/OMS/literature.md", contract: "literature", naming: "{{slug}}.md" } } });
  const taxonomy = "folders: {}\n";
  const obsidianTypes = JSON.stringify({ types: { template: "text", title: "text", "source-url": "text" } });
  const template = "---\ntemplate: literature\ntitle: Untitled\nsource-url:\n---\n# Literature\n<!-- oms:content -->\n";
  const sources: SourceDescriptor[] = [{ logicalId: "template-policy", signature: templateDigest(policy) }, { logicalId: "taxonomy", signature: templateDigest(taxonomy) }, { logicalId: "obsidian-types", signature: templateDigest(obsidianTypes) }, { path: "Templates/OMS/literature.md", signature: templateDigest(template) }];
  const projection = JSON.stringify({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sources), sources }, managed: { base: { fields: {} }, globalAxes: {}, templates: { literature: { templateId: "literature", destinationClass: "managed-default", sourcePath: "Templates/OMS/literature.md", targetFolder: "Inbox", keyOrder: ["template", "title", "source-url"], fields: { template: { type: "text", required: true }, title: { type: "text", required: true }, "source-url": { type: "text", required: true } }, views: [], naming: "{{slug}}.md", bodySignature: templateDigest("# Literature\n<!-- oms:content -->\n") } } } });
  await Promise.all([mkdir(path.join(vault, ".oms"), { recursive: true }), mkdir(path.join(vault, ".obsidian"), { recursive: true }), mkdir(path.join(vault, "Templates", "OMS"), { recursive: true })]);
  await Promise.all([writeFile(path.join(vault, ".oms", "template-policy.json"), policy), writeFile(path.join(vault, ".oms", "taxonomy.yaml"), taxonomy), writeFile(path.join(vault, ".oms", "types.json"), projection), writeFile(path.join(vault, ".obsidian", "types.json"), obsidianTypes), writeFile(path.join(vault, "Templates", "OMS", "literature.md"), template)]);
}

async function createLinkTemplateAuthority(vault: string): Promise<void> {
  const policy = JSON.stringify({ version: 1, templateFolder: "Templates/OMS", base: { fields: {} }, contracts: { note: { intent: "A note.", fields: { template: { type: "text", required: true }, title: { type: "text", required: true } }, views: [] } }, templates: { note: { templateId: "note", destinationClass: "managed-default", sourcePath: "Templates/OMS/note.md", contract: "note", naming: "{{slug}}.md" } } });
  const taxonomy = "folders: {}\n";
  const obsidianTypes = JSON.stringify({ types: { template: "text", title: "text", aliases: "aliases" } });
  const template = "---\ntemplate: note\ntitle: Untitled\n---\n<!-- oms:content -->\n";
  const sources: SourceDescriptor[] = [{ logicalId: "template-policy", signature: templateDigest(policy) }, { logicalId: "taxonomy", signature: templateDigest(taxonomy) }, { logicalId: "obsidian-types", signature: templateDigest(obsidianTypes) }, { path: "Templates/OMS/note.md", signature: templateDigest(template) }];
  const projection = JSON.stringify({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sources), sources }, managed: { base: { fields: {} }, globalAxes: {}, templates: { note: { templateId: "note", destinationClass: "managed-default", sourcePath: "Templates/OMS/note.md", targetFolder: "Inbox", keyOrder: ["template", "title"], fields: { template: { type: "text", required: true }, title: { type: "text", required: true } }, views: [], naming: "{{slug}}.md", bodySignature: templateDigest("<!-- oms:content -->\n") } } } });
  await Promise.all([mkdir(path.join(vault, ".oms"), { recursive: true }), mkdir(path.join(vault, ".obsidian"), { recursive: true }), mkdir(path.join(vault, "Templates", "OMS"), { recursive: true })]);
  await Promise.all([writeFile(path.join(vault, ".oms", "template-policy.json"), policy), writeFile(path.join(vault, ".oms", "taxonomy.yaml"), taxonomy), writeFile(path.join(vault, ".oms", "types.json"), projection), writeFile(path.join(vault, ".obsidian", "types.json"), obsidianTypes), writeFile(path.join(vault, "Templates", "OMS", "note.md"), template)]);
}

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
  smokeHome = await mkdtemp(path.join(tmpdir(), "oms-mcp-server-home-"));
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

describe("Oh My Second Brain MCP stdio server", () => {
  it("advertises query defaults that match the SearchBackend contract", () => {
    const search = omsMcpTools.find((tool) => tool.name === "oms_search");
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
    expect(operationNames).toEqual(expect.arrayContaining(["query", "collections", "contexts", "status"]));
    for (const retired of ["axis", "semantic-query", "semantic-collections", "semantic-contexts", "semantic-status"]) {
      expect(operationNames).not.toContain(retired);
    }
  });

  it("keeps query budget schemas aligned with the runtime contract", () => {
    const validator = new AjvJsonSchemaValidator();
    const search = omsMcpTools.find((tool) => tool.name === "oms_search");
    const validate = validator.getValidator(search!.inputSchema);

    expect(validate({ op: "query", query: "architecture", limit: 0, candidateLimit: 1 }).valid).toBe(true);
    expect(validate({ op: "query", query: "architecture", limit: 1.5 }).valid).toBe(false);
    expect(validate({ op: "query", query: "architecture", candidateLimit: 0 }).valid).toBe(false);
    expect(validate({ op: "query", query: "architecture", candidateLimit: 1.5 }).valid).toBe(false);
    expect(validate({
      op: "query",
      query: "architecture",
      strategy: { kind: "expand", profile: "qmd-v2.8.3", maxQueries: 32 },
    }).valid).toBe(true);
    expect(validate({
      op: "query",
      query: "architecture",
      strategy: { kind: "expand", profile: "qmd-v2.8.3", maxQueries: 0 },
    }).valid).toBe(false);
    expect(validate({
      op: "query",
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
      args: [distCli, "mcp", "--vault", fixtureVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-query-surface-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      for (const op of ["semantic-query", "axis"]) {
        const result = await client.callTool({ name: "oms_search", arguments: { op, query: "architecture" } });
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
      args: [distCli, "mcp", "--vault", fixtureVault],
      cwd: repoRoot,
      env: stdioEnv({ OMS_EMBEDDING_PROVIDER: undefined, OMS_EMBEDDING_MODEL: undefined }),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-index-guidance-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "oms_search", arguments: { op: "collections" } });
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
      if (schema.oneOf === undefined) {
        expect(operation, `${skill} must not declare an op for a direct tool`).toBeUndefined();
      } else {
        expect(typeof operation, `${skill}.mcp_args.op must be a string`).toBe("string");
        expect(declaredOperations, `${skill}.mcp_args.op must match its tool operation`).toContain(operation);
      }
    }
  });

  it("advertises containsAll and between field predicates with strict tuple shapes", () => {
    const validator = new AjvJsonSchemaValidator();
    const search = omsMcpTools.find((tool) => tool.name === "oms_search");
    const schema = search?.inputSchema;
    const validate = validator.getValidator(schema!);

    expect(validate({
      op: "query",
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
      query: "typed axes",
      axes: { field: { tags: { containsAll: "one" } } },
    }).valid).toBe(false);
    expect(validate({
      op: "query",
      query: "typed axes",
      axes: { field: { score: { between: [1] } } },
    }).valid).toBe(false);
    expect(validate({
      op: "query",
      query: "typed axes",
      axes: { field: { score: { between: [1, 10, 20] } } },
    }).valid).toBe(false);
  });

  it("advertises the complete write payload and zero-argument status contract", () => {
    const validator = new AjvJsonSchemaValidator();
    const toolByName = new Map(omsMcpTools.map((tool) => [tool.name, tool]));
    const write = validator.getValidator(toolByName.get("oms_write")!.inputSchema);
    const status = validator.getValidator(toolByName.get("oms_status")!.inputSchema);

    expect(write({
      op: "note",
      mode: "create",
      templateId: "literature",
      frontmatter: { title: "Schema Valid", "source-url": "https://example.com/schema-valid" },
      body: "A schema-valid write payload.",
    }).valid).toBe(true);
    expect(status({}).valid).toBe(true);
    expect(status({ op: "status" }).valid).toBe(false);
    expect(write({
      op: "template",
      transactionId: "tx-resume",
      approvedDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }).valid).toBe(true);
    expect(write({ op: "note", mode: "create", templateId: "literature", notePath: "notes/x.md", body: "x" }).valid).toBe(false);
    expect(write({ op: "note", mode: "append", notePath: "notes/x.md", body: "x" }).valid).toBe(true);
    expect(write({ op: "note", mode: "append", templateId: "literature", notePath: "notes/x.md", body: "x" }).valid).toBe(false);
    expect(write({ op: "note", mode: "update", notePath: "notes/x.md" }).valid).toBe(false);
    expect(write({ op: "note", mode: "update", notePath: "notes/x.md", frontmatter: { title: "x" } }).valid).toBe(true);
    expect(write({ op: "note", templateId: "literature", mode: "create", folder: "references" }).valid).toBe(false);
    expect(JSON.stringify(toolByName.get("oms_search")!.inputSchema)).not.toContain("concept");
  });

  it("requires an op for routed tools", () => {
    const normalOperations = [
      ["oms_write", "note", "write-note"],
      ["oms_search", "query", "oms_semantic_query"],
      ["oms_link", "suggest", "oms_link_suggest"],
      ["oms_status", undefined, "oms_graph_status"],
      ["oms_doctor", "audit", "oms_vault_audit"],
    ] as const;
    const schemas = new Map(omsMcpTools.map((tool) => [tool.name, tool.inputSchema as {
      readonly required?: readonly string[];
      readonly oneOf?: readonly { readonly required: readonly string[] }[];
    }]));

    for (const [tool, op] of normalOperations) {
      if (tool === "oms_status") {
        expect(schemas.get(tool)?.required).not.toContain("op");
      } else {
        expect(op).toBeDefined();
        expect(schemas.get(tool)?.oneOf?.every((branch) => branch.required.includes("op")), tool).toBe(true);
      }
    }
  });

  it("registers only the five public tools and retires detail aliases", () => {
    expect(omsMcpTools.map((tool) => tool.name)).toEqual([
      "oms_write",
      "oms_search",
      "oms_link",
      "oms_status",
      "oms_doctor",
    ]);
    expect(omsMcpTools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([
        "query", "get", "multi_get", "status",
        "oms_graph_status", "oms_graph_build", "oms_list_concepts",
        "oms_retrieve_by_axis", "oms_retrieve_context", "oms_lazy_load_note",
        "oms_validate_contract", "oms_vault_audit", "oms_link_suggest", "oms_link_apply",
        "oms_sync_embeddings", "oms_semantic_query", "oms_semantic_status",
        "oms_semantic_collections", "oms_semantic_contexts", "oms_semantic_cleanup",
        "oms_get_document", "oms_multi_get_documents",
      ]),
    );
  });

  it.each([
    ["typed vec searches", { op: "query", searches: [{ type: "vec", query: "telescope" }] }],
    ["vec field", { op: "query", vec: "telescope" }],
    ["hyde field", { op: "query", hyde: "hypothetical telescope answer" }],
    ["vsearch mode", { op: "query", query: "telescope", mode: "vsearch" }],
    ["expand strategy", { op: "query", query: "telescope", strategy: { kind: "expand", profile: "qmd-v2.8.3" } }],
  ])("fails loudly for explicit vector retrieval via %s without embedding configuration", async (_strategy, arguments_) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", fixtureVault],
      cwd: repoRoot,
      env: stdioEnv({ OMS_EMBEDDING_PROVIDER: undefined, OMS_EMBEDDING_MODEL: undefined }),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "oms_search", arguments: arguments_ });
      expect(result.isError).toBe(true);
      const message = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(message).toContain("OMS_EMBEDDING_PROVIDER");
      expect(message).toContain("OMS_EMBEDDING_MODEL");
    } finally {
      await client.close();
    }
  });

  it("does not discard vec shorthand when typed searches are also supplied", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", fixtureVault],
      cwd: repoRoot,
      env: stdioEnv({ OMS_EMBEDDING_PROVIDER: undefined, OMS_EMBEDDING_MODEL: undefined }),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "oms_search",
        arguments: {
          op: "query",
          searches: [{ type: "lex", query: "architecture" }],
          vec: "explicit vector",
        },
      });
      expect(result.isError).toBe(true);
      const message = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(message).toContain("OMS_EMBEDDING_PROVIDER");
      expect(message).toContain("OMS_EMBEDDING_MODEL");
    } finally {
      await client.close();
    }
  });

  it("reports the package.json version in the MCP handshake", async () => {
    // Given: the version declared by the shipped package manifest
    const manifest: unknown = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf-8"),
    );
    const declaredVersion =
      typeof manifest === "object" && manifest !== null && "version" in manifest
        ? (manifest as { version: unknown }).version
        : undefined;
    expect(typeof declaredVersion).toBe("string");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", fixtureVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      // When: a client completes the initialize handshake
      await client.connect(transport);

      // Then: the server advertises the real package version, not the placeholder
      const serverVersion = client.getServerVersion();
      expect(serverVersion?.name).toBe("oms");
      expect(serverVersion?.version).toBe(declaredVersion);
      expect(serverVersion?.version).not.toBe("0.0.0");
    } finally {
      await client.close();
    }
  });

  it("exposes read/status tools and validates a fixture note", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", fixtureVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toEqual(harnessSurfaceRegistry.mcpTools.map((tool) => tool.name));
      for (const registryTool of harnessSurfaceRegistry.mcpTools) {
        const tool = tools.tools.find((candidate) => candidate.name === registryTool.name);
        expect(tool, registryTool.name).toBeDefined();
        expect(tool?.annotations?.readOnlyHint).toBe(registryTool.posture === "read");
        expect(tool?.annotations?.destructiveHint).toBe(registryTool.destructive);
        expect(tool?.annotations?.idempotentHint).toBe(registryTool.idempotent);
        expect(tool?.annotations?.openWorldHint).toBe(registryTool.openWorld);
      }
      const retrieveTool = tools.tools.find((tool) => tool.name === "oms_search");
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
      const doctorTool = tools.tools.find((tool) => tool.name === "oms_doctor");
      expect(doctorTool?.annotations?.readOnlyHint).toBe(false);
      expect(JSON.stringify(doctorTool?.inputSchema)).toContain("audit");

      const status = await client.callTool({ name: "oms_status", arguments: {} });
      const parsedStatus = textPayload(status);
      expect(parsedStatus.writeTools).toBe("oms_write-disabled-invalid-template-projection");
      const writeTool = tools.tools.find((tool) => tool.name === "oms_write");
      expect(writeTool?.annotations?.readOnlyHint).toBe(false);
      expect(JSON.stringify(writeTool?.inputSchema)).toContain("update");
      expect(parsedStatus.counts).toBeNull();
      expect(parsedStatus.projectionSource).toBe("vault-invalid");
      const derivedState = parsedStatus.derivedState as Record<string, unknown>;
      expect(derivedState.status).toBe("invalid");

      const templateDiagnosis = textPayload(await client.callTool({
        name: "oms_doctor",
        arguments: { op: "validate" },
      }));
      expect(templateDiagnosis.status).toBe("needs-repair");
      const audit = await client.callTool({
        name: "oms_doctor",
        arguments: { op: "audit", folder: "references" },
      });
      const parsedAudit = textPayload(audit);
      expect(parsedAudit.clean).toBe(false);
      expect(parsedAudit.scannedNotes).toBe(0);
      const nonStringFolderAudit = await client.callTool({
        name: "oms_doctor",
        arguments: { op: "audit", folder: 123 },
      });
      expect(nonStringFolderAudit.isError).toBe(true);
      expect(nonStringFolderAudit.content[0]?.type === "text" ? nonStringFolderAudit.content[0].text : "").toContain(
        'Argument "folder" must be a string',
      );

      const missingVaultFolderAudit = textPayload(await client.callTool({
        name: "oms_doctor",
        arguments: { op: "audit", folder: "inbox" },
      }));
      expect(missingVaultFolderAudit).toMatchObject({ clean: false, scannedNotes: 0 });
    } finally {
      await client.close();
    }
  });

  it("retrieves live graph context without requiring a warm cache or semantic backend", async () => {
    const tmpVault = await mkdtemp(path.join(tmpdir(), "oms-mcp-retrieve-"));
    await createMcpTemplateAuthority(tmpVault);
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
      args: [distCli, "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const result = textPayload(
        await client.callTool({
          name: "oms_search",
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

  it("reports invalid local .oms instead of falling back to bundled defaults", async () => {
    const tmpVault = await mkdtemp(path.join(tmpdir(), "oms-invalid-"));
    await createMcpTemplateAuthority(tmpVault);
    await writeFile(path.join(tmpVault, ".oms", "types.json"), "{invalid", "utf-8");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const status = textPayload(await client.callTool({ name: "oms_status", arguments: {} }));
      expect(status.projectionSource).toBe("vault-invalid");
      expect(status.writeTools).toBe("oms_write-disabled-invalid-template-projection");

      const write = await client.callTool({
        name: "oms_write",
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
      expect(write.content[0]?.type === "text" ? write.content[0].text : "").toContain(
        "Oh My Second Brain MCP error",
      );
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("does not treat cache-only .oms as a broken local ontology", async () => {
    const tmpVault = await mkdtemp(path.join(tmpdir(), "oms-cache-only-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);
      expect(textPayload(await client.callTool({ name: "oms_status", arguments: {} })).projectionSource).toBe("vault-invalid");

      await client.callTool({ name: "oms_doctor", arguments: { op: "build-graph",} });

      expect(textPayload(await client.callTool({ name: "oms_status", arguments: {} })).projectionSource).toBe("vault-invalid");
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
      args: [distCli, "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const status = textPayload(await client.callTool({ name: "oms_status", arguments: {} }));
      expect(status.projectionSource).toBe("vault-invalid");
      expect(status.writeTools).toBe("oms_write-disabled-invalid-template-projection");

      const write = await client.callTool({
        name: "oms_write",
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
      args: [distCli, "mcp", "--vault", tmpVault],
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
        name: "oms_write",
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
      const text = raw.content[0]?.type === "text" ? raw.content[0].text : "";
      expect(text).toMatch(/Unknown operation|schema|invalid|additional/i);
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("writes through write against the kernel contract", async () => {
    const tmpVault = await mkdtemp(path.join(tmpdir(), "oms-mcp-write-"));
    await createMcpTemplateAuthority(tmpVault);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const asked = textPayload(
        await client.callTool({
          name: "oms_write",
          arguments: {
            op: "note",
            mode: "create",
            templateId: "literature",
            frontmatter: { title: "Incomplete" },
            body: "Body",
          },
        }),
      );
      expect(asked.status).toBe("ask");
      expect((asked.violations as Array<Record<string, unknown>>).some((item) => item.field === "source-url" && item.rule === "required")).toBe(true);

      const created = textPayload(
        await client.callTool({
          name: "oms_write",
          arguments: {
            op: "note",
            mode: "create",
            templateId: "literature",
            frontmatter: {
              title: "Kernel Note",
              "source-url": "https://example.com/kernel-note",
              extra: "kept",
            },
            body: "Created by write.",
          },
        }),
      );
      expect(created.status).toBe("written");
      expect(created.notePath).toBe("Inbox/kernel-note.md");
      expect(created.resolvedVault).toBe(tmpVault);
      expect(created.resolutionSource).toBe("explicit");
      expect(created.receipt).toMatchObject({
        resolvedVault: tmpVault,
        resolutionSource: "explicit",
        notePath: "Inbox/kernel-note.md",
        mode: "create",
        postconditionVerified: true,
      });
      expect(asked.resolvedVault).toBe(tmpVault);
      expect(asked.resolutionSource).toBe("explicit");

      const broken = textPayload(
        await client.callTool({
          name: "oms_write",
          arguments: {
            op: "note",
            mode: "update",
            notePath: "Inbox/kernel-note.md",
            frontmatter: { title: "" },
          },
        }),
      );
      expect(broken.status).toBe("rejected");
      expect((broken.violations as Array<Record<string, unknown>>)[0]?.rule).toBe("required");
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("suggests term links for a note and applies them only against a current hash", async () => {
    // Given: a vault with two term notes (one carrying a Korean alias) and a
    // note whose body mentions both surfaces in prose
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
    await writeFile(
      noteFile,
      "---\ntemplate: note\ntitle: Sage\n---\n\nThe sage pursues Ataraxia through Stoicism.\n아타락시아를 향한 길.\n",
      "utf-8",
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      // When: link suggestions are requested for the mentioning note
      const suggested = textPayload(
        await client.callTool({ name: "oms_link", arguments: { op: "suggest", notePath } }),
      );

      // Then: both term notes are proposed, first-occurrence only, with a hash
      expect(suggested.notePath).toBe(notePath);
      expect(typeof suggested.baseContentHash).toBe("string");
      const candidates = suggested.candidates as Array<Record<string, unknown>>;
      expect(candidates.map((candidate) => candidate.targetPath).sort()).toEqual([
        "terms/Ataraxia.md",
        "terms/Stoicism.md",
      ]);
      const ataraxia = candidates.find((candidate) => candidate.targetPath === "terms/Ataraxia.md");
      expect(ataraxia?.matchedText).toBe("Ataraxia");
      expect(ataraxia?.renderedReplacement).toBe("[[Ataraxia]]");
      expect(typeof ataraxia?.id).toBe("string");
      // The note being linkified is never a candidate for itself.
      expect(candidates.some((candidate) => candidate.targetPath === notePath)).toBe(false);

      // When: apply runs with a hash that no longer describes the note
      const beforeApply = await readFile(noteFile, "utf-8");
      const stale = textPayload(
        await client.callTool({
          name: "oms_link",
          arguments: { op: "apply",
            notePath,
            baseContentHash: "0".repeat(64),
            candidateIds: candidates.map((candidate) => candidate.id),
          },
        }),
      );

      // Then: nothing is written and the refusal names the stale state
      expect(stale.applied).toBe(false);
      expect(stale.reason).toBe("note-changed");
      expect(await readFile(noteFile, "utf-8")).toBe(beforeApply);

      // When: apply runs with the hash the suggestions were computed against
      const applied = textPayload(
        await client.callTool({
          name: "oms_link",
          arguments: { op: "apply",
            notePath,
            baseContentHash: suggested.baseContentHash,
            candidateIds: candidates.map((candidate) => candidate.id),
          },
        }),
      );

      // Then: the persisted file bytes carry the wikilinks
      expect(applied.applied).toBe(true);
      expect(applied.receipt).toMatchObject({ notePath, mode: "update", postconditionVerified: true });
      const persisted = await readFile(noteFile, "utf-8");
      expect(persisted).not.toBe(beforeApply);
      expect(persisted).toContain("[[Ataraxia]]");
      expect(persisted).toContain("[[Stoicism]]");
      expect(persisted).toContain("title: Sage");

      // When: the same (now stale) hash is replayed
      const replayed = textPayload(
        await client.callTool({
          name: "oms_link",
          arguments: { op: "apply",
            notePath,
            baseContentHash: suggested.baseContentHash,
            candidateIds: candidates.map((candidate) => candidate.id),
          },
        }),
      );

      // Then: it is refused and the file is untouched
      expect(replayed.applied).toBe(false);
      expect(replayed.reason).toBe("note-changed");
      expect(await readFile(noteFile, "utf-8")).toBe(persisted);
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
      args: [distCli, "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      // When: notePath is omitted
      const missing = await client.callTool({ name: "oms_link", arguments: { op: "suggest",} });
      // Then: the tool reports a typed argument error
      expect(missing.isError).toBe(true);
      expect(missing.content[0]?.type === "text" ? missing.content[0].text : "").toContain("notePath");

      // When: the note does not exist
      const absent = await client.callTool({
        name: "oms_link",
        arguments: { op: "suggest", notePath: "notes/does-not-exist.md" },
      });
      // Then: the tool errors instead of inventing an empty suggestion set
      expect(absent.isError).toBe(true);

      // When: apply omits the base hash
      const noHash = await client.callTool({
        name: "oms_link",
        arguments: { op: "apply", notePath: "notes/sage.md", candidateIds: [] },
      });
      // Then: the tool refuses before any write
      expect(noHash.isError).toBe(true);
      expect(noHash.content[0]?.type === "text" ? noHash.content[0].text : "").toContain("baseContentHash");
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
      args: [distCli, "mcp"],
      cwd: tmpCwd,
      env: { HOME: tmpHome, PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const status = textPayload(await client.callTool({ name: "oms_status", arguments: {} }));
      expect(status.writeTools).toBe("oms_write-disabled-target-unverified");

      const write = textPayload(
        await client.callTool({
          name: "oms_write",
          arguments: {
            op: "note",
            mode: "create",
            templateId: "literature",
            frontmatter: {
              title: "Misrouted Note",
              "source-url": "https://example.com/misrouted",
            },
            body: "Must not land in the booting directory.",
          },
        }),
      );
      expect(write.status).toBe("rejected");
      expect(write.rejection).toMatchObject({
        stage: "admission",
        code: "target-unverified",
        recoverable: true,
      });
      expect(write.receipt).toBeUndefined();
      expect(write.resolvedVault).toBe(tmpCwd);
      expect(write.resolutionSource).toBe("cwd");

      const linkApply = textPayload(await client.callTool({ name: "oms_link", arguments: { op: "apply", notePath: "notes/misrouted.md", baseContentHash: "0".repeat(64), candidateIds: [] } }));
      expect(linkApply).toMatchObject({ applied: false, reason: "write-rejected", write: { rejection: { code: "target-unverified" } } });
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
      args: [distCli, "mcp"],
      cwd: tmpCwd,
      env: { HOME: tmpHome, PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      for (const op of ["build-graph", "cleanup", "sync-embeddings"]) {
        const repair = textPayload(await client.callTool({ name: "oms_doctor", arguments: { op } }));
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

      const audit = textPayload(await client.callTool({ name: "oms_doctor", arguments: { op: "audit" } }));
      expect(audit).toMatchObject({ vault: tmpCwd, projectionSource: "vault-invalid", clean: false });
      const templateDiagnosis = textPayload(
        await client.callTool({ name: "oms_doctor", arguments: { op: "validate" } }),
      );
      expect(templateDiagnosis.status).toBe("needs-repair");
      expect(await readdir(tmpCwd)).toEqual(["notes"]);
    } finally {
      await client.close();
      await rm(tmpCwd, { recursive: true, force: true });
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("returns a server-verified graph repair receipt for a verified target", async () => {
    const tmpVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-mcp-doctor-vault-")));
    await createMcpTemplateAuthority(tmpVault);
    await mkdir(path.join(tmpVault, "notes"), { recursive: true });
    await writeFile(path.join(tmpVault, "notes", "graph-note.md"), "---\ntemplate: literature\ntitle: Graph Note\nsource-url: https://example.com/graph-note\n---\nGraph note.\n", "utf-8");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp"],
      cwd: tmpVault,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);
      const repair = textPayload(
        await client.callTool({ name: "oms_doctor", arguments: { op: "build-graph" } }),
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
    await createMcpTemplateAuthority(tmpVault);
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
      args: [distCli, "mcp"],
      cwd: tmpVault,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);
      const result = textPayload(await client.callTool({ name: "oms_doctor", arguments: { op: "build-graph" } }));
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
    await mkdir(path.join(tmpVault, ".oms", "concepts"), { recursive: true });
    await writeFile(path.join(tmpVault, ".oms", "taxonomy.yaml"), "version: 1\nfolders: {}\n", "utf-8");
    await writeFile(path.join(tmpVault, "note.md"), "# Indexed note\n", "utf-8");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp"],
      cwd: tmpVault,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);
      const repair = textPayload(
        await client.callTool({ name: "oms_doctor", arguments: { op: "sync-embeddings", embed: false } }),
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
    await mkdir(path.join(tmpVault, ".oms", "concepts"), { recursive: true });
    await writeFile(path.join(tmpVault, ".oms", "taxonomy.yaml"), "version: 1\nfolders: {}\n", "utf-8");
    await writeFile(path.join(tmpVault, "removed.md"), "# Removed note\n", "utf-8");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp"],
      cwd: tmpVault,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);
      textPayload(
        await client.callTool({ name: "oms_doctor", arguments: { op: "sync-embeddings", embed: false } }),
      );
      await rm(path.join(tmpVault, "removed.md"));
      const repair = textPayload(
        await client.callTool({ name: "oms_doctor", arguments: { op: "cleanup" } }),
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
    const tmpHome = await mkdtemp(path.join(tmpdir(), "oms-mcp-vault-home-"));
    const tmpVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-mcp-local-vault-")));
    await createMcpTemplateAuthority(tmpVault);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp"],
      cwd: tmpVault,
      env: { HOME: tmpHome, PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const status = textPayload(await client.callTool({ name: "oms_status", arguments: {} }));
      expect(status.writeTools).toBe("oms_write-gated-by-verified-target-and-contract");

      const created = textPayload(
        await client.callTool({
          name: "oms_write",
          arguments: {
            op: "note",
            mode: "create",
            templateId: "literature",
            frontmatter: { title: "Local Vault Note", "source-url": "https://example.com/local-vault-note" },
            body: "Written from inside the vault.",
          },
        }),
      );
      expect(created.status).toBe("written");
      expect(created.resolutionSource).toBe("vault");
      expect(created.resolvedVault).toBe(tmpVault);
      expect(created.receipt).toMatchObject({
        resolutionSource: "vault",
        postconditionVerified: true,
      });
      expect(await readdir(path.join(tmpVault, "Inbox"))).toEqual(["local-vault-note.md"]);
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
      await rm(tmpHome, { recursive: true, force: true });
    }
  });
});
