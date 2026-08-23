import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { parse } from "yaml";
import { harnessSurfaceRegistry } from "../kernel/harness/surface-registry.js";
import { omsMcpTools } from "./server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../");
const fixtureVault = path.join(repoRoot, "test", "fixtures", "vault");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");

function textPayload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  return JSON.parse(block.type === "text" ? block.text : "{}") as Record<string, unknown>;
}

describe("Oh My Second Brain MCP stdio server", () => {
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
    }
  });

  it("advertises the complete write payload and zero-argument status contract", () => {
    const validator = new AjvJsonSchemaValidator();
    const toolByName = new Map(omsMcpTools.map((tool) => [tool.name, tool]));
    const write = validator.getValidator(toolByName.get("oms_write")!.inputSchema);
    const status = validator.getValidator(toolByName.get("oms_status")!.inputSchema);

    expect(write({
      op: "create",
      notePath: "references/schema-valid.md",
      concept: "literature",
      frontmatter: { title: "Schema Valid", "source-url": "https://example.com/schema-valid" },
      body: "A schema-valid write payload.",
    }).valid).toBe(true);
    expect(status({}).valid).toBe(true);
    expect(status({ op: "status" }).valid).toBe(false);
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
    ["typed vec searches", { op: "semantic-query", searches: [{ type: "vec", query: "telescope" }] }],
    ["vec field", { op: "semantic-query", vec: "telescope" }],
    ["hyde field", { op: "semantic-query", hyde: "hypothetical telescope answer" }],
    ["vsearch mode", { op: "semantic-query", query: "telescope", mode: "vsearch" }],
  ])("fails loudly for explicit vector retrieval via %s without embedding configuration", async (_strategy, arguments_) => {
    const env = { ...process.env };
    delete env.OMS_EMBEDDING_PROVIDER;
    delete env.OMS_EMBEDDING_MODEL;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", fixtureVault],
      cwd: repoRoot,
      env,
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
    const env = { ...process.env };
    delete env.OMS_EMBEDDING_PROVIDER;
    delete env.OMS_EMBEDDING_MODEL;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", fixtureVault],
      cwd: repoRoot,
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "oms_search",
        arguments: {
          op: "semantic-query",
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
      expect(retrieveTool?.annotations?.readOnlyHint).toBe(false);
      expect(JSON.stringify(retrieveTool?.inputSchema)).toContain("semantic-query");
      expect(JSON.stringify(retrieveTool?.inputSchema)).toContain("get-document");
      expect(JSON.stringify(retrieveTool?.inputSchema)).not.toContain("modelPath");
      const doctorTool = tools.tools.find((tool) => tool.name === "oms_doctor");
      expect(doctorTool?.annotations?.readOnlyHint).toBe(false);
      expect(JSON.stringify(doctorTool?.inputSchema)).toContain("audit");

      const status = await client.callTool({ name: "oms_status", arguments: {} });
      const parsedStatus = textPayload(status);
      expect(parsedStatus.writeTools).toBe("oms_write-gated-by-verified-target-and-contract");
      const writeTool = tools.tools.find((tool) => tool.name === "oms_write");
      expect(writeTool?.annotations?.readOnlyHint).toBe(false);
      expect(JSON.stringify(writeTool?.inputSchema)).toContain("update");
      expect(parsedStatus.counts.concepts).toBeGreaterThan(0);
      const derivedState = parsedStatus.derivedState as Record<string, unknown>;
      const staleness = derivedState.staleness as Record<string, unknown>;
      expect(staleness.graphStale).toBe(true);

      const validation = await client.callTool({
        name: "oms_doctor",
        arguments: { op: "validate", notePath: "references/clean-architecture.md" },
      });
      const parsedValidation = textPayload(validation);
      expect(parsedValidation.valid).toBe(true);
      expect(parsedValidation.concept).toBe("literature");
      const audit = await client.callTool({
        name: "oms_doctor",
        arguments: { op: "audit", folder: "references" },
      });
      const parsedAudit = textPayload(audit);
      expect(parsedAudit.clean).toBe(true);
      expect(parsedAudit.scannedNotes).toBe(1);
      expect(parsedAudit.excludedNotes).toBe(0);
      const nonStringFolderAudit = await client.callTool({
        name: "oms_doctor",
        arguments: { op: "audit", folder: 123 },
      });
      expect(nonStringFolderAudit.isError).toBe(true);
      expect(nonStringFolderAudit.content[0]?.type === "text" ? nonStringFolderAudit.content[0].text : "").toContain(
        'Argument "folder" must be a string',
      );

      const missingVaultFolderAudit = await client.callTool({
        name: "oms_doctor",
        arguments: { op: "audit", folder: "inbox" },
      });
      expect(missingVaultFolderAudit.isError).toBe(true);
      expect(
        missingVaultFolderAudit.content[0]?.type === "text" ? missingVaultFolderAudit.content[0].text : "",
      ).toContain('Audit folder "inbox" does not exist');
    } finally {
      await client.close();
    }
  });

  it("retrieves live graph context without requiring a warm cache or semantic backend", async () => {
    const tmpVault = await mkdtemp(path.join(tmpdir(), "oms-mcp-retrieve-"));
    await mkdir(path.join(tmpVault, "references"), { recursive: true });
    await writeFile(
      path.join(tmpVault, "references", "Agent Retrieval.md"),
      `---
title: Agent Retrieval
tags:
  - agent-graph
---
Agent retrieval follows [[Graph Index]].
`,
      "utf-8",
    );
    await writeFile(
      path.join(tmpVault, "references", "Graph Index.md"),
      `---
title: Graph Index
tags:
  - agent-graph
---
Index note.
`,
      "utf-8",
    );
    await writeFile(
      path.join(tmpVault, "references", "Malformed.md"),
      `---
title: [broken
---
Malformed frontmatter must not block retrieve.
`,
      "utf-8",
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const result = textPayload(
        await client.callTool({
          name: "oms_search",
          arguments: { op: "context",
            property: "tags",
            value: "agent-graph",
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
    await mkdir(path.join(tmpVault, ".oms", "concepts"), { recursive: true });
    await writeFile(path.join(tmpVault, ".oms", "taxonomy.yaml"), "not: [valid", "utf-8");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const status = textPayload(await client.callTool({ name: "oms_status", arguments: {} }));
      expect(status.ontologySource).toBe("vault-invalid");
      expect(status.writeTools).toBe("oms_write-disabled-invalid-ontology");

      const write = await client.callTool({
        name: "oms_write",
        arguments: {
          notePath: "references/unsafe.md",
          frontmatter: {
            title: "Should not write",
            "source-url": "https://example.com/should-not-write",
          },
          body: "Should not write.",
          op: "create",
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
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);
      expect(textPayload(await client.callTool({ name: "oms_status", arguments: {} })).ontologySource).toBe(
        "bundled",
      );

      await client.callTool({ name: "oms_doctor", arguments: { op: "build-graph",} });

      expect(textPayload(await client.callTool({ name: "oms_status", arguments: {} })).ontologySource).toBe(
        "bundled",
      );
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
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const status = textPayload(await client.callTool({ name: "oms_status", arguments: {} }));
      expect(status.ontologySource).toBe("vault-invalid");
      expect(status.writeTools).toBe("oms_write-disabled-invalid-ontology");

      const write = await client.callTool({
        name: "oms_write",
        arguments: {
          notePath: "references/unsafe.md",
          frontmatter: {
            title: "Should not write",
            "source-url": "https://example.com/should-not-write",
          },
          body: "Should not write.",
          op: "create",
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
          op: "create",
          notePath: "notes/x.md",
          folder: "notes",
          filename: "x.md",
          body: "Body",
        },
      });

      expect(raw.isError).toBe(true);
      const text = raw.content[0]?.type === "text" ? raw.content[0].text : "";
      expect(text).toMatch(/notePath.*folder.*filename|not both/i);
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("writes through write against the kernel contract", async () => {
    const tmpVault = await mkdtemp(path.join(tmpdir(), "oms-mcp-write-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const asked = textPayload(
        await client.callTool({
          name: "oms_write",
          arguments: {
            op: "create",
            concept: "literature",
            frontmatter: { title: "Incomplete" },
            body: "Body",
          },
        }),
      );
      expect(asked.status).toBe("ask");
      expect(asked.missingFields).toEqual(["source-url"]);

      const created = textPayload(
        await client.callTool({
          name: "oms_write",
          arguments: {
            op: "create",
            notePath: "references/kernel-note.md",
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
      expect(created.notePath).toBe("references/kernel-note.md");
      expect(created.resolvedVault).toBe(tmpVault);
      expect(created.resolutionSource).toBe("explicit");
      expect(created.receipt).toMatchObject({
        resolvedVault: tmpVault,
        resolutionSource: "explicit",
        notePath: "references/kernel-note.md",
        mode: "create",
        postconditionVerified: true,
      });
      expect(asked.resolvedVault).toBe(tmpVault);
      expect(asked.resolutionSource).toBe("explicit");

      const broken = textPayload(
        await client.callTool({
          name: "oms_write",
          arguments: {
            op: "update",
            notePath: "references/kernel-note.md",
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
    await mkdir(path.join(tmpVault, "terms"), { recursive: true });
    await mkdir(path.join(tmpVault, "notes"), { recursive: true });
    await writeFile(
      path.join(tmpVault, "terms", "Ataraxia.md"),
      "---\ntitle: Ataraxia\naliases:\n  - 아타락시아\n---\n\nFreedom from disturbance.\n",
      "utf-8",
    );
    await writeFile(
      path.join(tmpVault, "terms", "Stoicism.md"),
      "---\ntitle: Stoicism\n---\n\nA school of thought.\n",
      "utf-8",
    );
    const notePath = "notes/sage.md";
    const noteFile = path.join(tmpVault, "notes", "sage.md");
    await writeFile(
      noteFile,
      "---\ntitle: Sage\n---\n\nThe sage pursues Ataraxia through Stoicism.\n아타락시아를 향한 길.\n",
      "utf-8",
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", tmpVault],
      cwd: repoRoot,
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
    // No --vault, a non-vault cwd, an empty HOME (no ~/.oms/config.yaml) and no
    // OMS_VAULT: resolution falls all the way through to the `cwd` source, which
    // is unverified for the write surface (issue #58).
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
            op: "create",
            notePath: "references/misrouted.md",
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

      for (const op of ["build-graph", "semantic-cleanup", "sync-embeddings"]) {
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
      expect(audit).toMatchObject({ vault: tmpCwd, ontologySource: "bundled" });
      const validate = textPayload(
        await client.callTool({
          name: "oms_doctor",
          arguments: { op: "validate", notePath: "notes/unbound.md" },
        }),
      );
      expect(validate).toMatchObject({ notePath: "notes/unbound.md", valid: true });
      expect(await readdir(tmpCwd)).toEqual(["notes"]);
    } finally {
      await client.close();
      await rm(tmpCwd, { recursive: true, force: true });
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("returns a server-verified graph repair receipt for a verified target", async () => {
    const tmpVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-mcp-doctor-vault-")));
    await mkdir(path.join(tmpVault, ".oms", "concepts"), { recursive: true });
    await writeFile(
      path.join(tmpVault, ".oms", "taxonomy.yaml"),
      "version: 1\nfolders:\n  notes:\n    concept: note\n",
      "utf-8",
    );
    await writeFile(
      path.join(tmpVault, ".oms", "concepts", "note.yaml"),
      "concept: note\nintent: A note.\nfolder: notes\nfields: []\n",
      "utf-8",
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp"],
      cwd: tmpVault,
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
      expect(repair).toMatchObject({
        vault: tmpVault,
        ontologySource: "vault",
        resolvedVault: tmpVault,
        resolutionSource: "vault",
      });
      expect(receipt.resolvedVault).toBe(tmpVault);
      expect(receipt.resolutionSource).toBe("vault");
      expect(postcondition.kind).toBe("graph-cache");
      const cache = JSON.parse(await readFile(postcondition.cachePath as string, "utf-8")) as Record<string, unknown>;
      expect(postcondition.generatedAt).toBe(cache.generatedAt);
      expect(postcondition.notes).toBe((cache.notes as unknown[]).length);
      expect(postcondition.edges).toBe((cache.edges as unknown[]).length);
      expect(postcondition.searchDocuments).toBe((cache.search as unknown[]).length);
      expect((receipt.written as Record<string, unknown>).paths).toEqual([postcondition.cachePath]);
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
        await client.callTool({ name: "oms_doctor", arguments: { op: "semantic-cleanup" } }),
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
    await mkdir(path.join(tmpVault, ".oms", "concepts"), { recursive: true });
    await writeFile(
      path.join(tmpVault, ".oms", "taxonomy.yaml"),
      "version: 1\nfolders:\n  references:\n    concept: literature\n",
      "utf-8",
    );
    await writeFile(
      path.join(tmpVault, ".oms", "concepts", "literature.yaml"),
      `concept: literature
intent: External sources worth revisiting.
folder: references
fields:
  - name: title
    type: string
    required: true
    intent: Human-readable title.
`,
      "utf-8",
    );

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
            op: "create",
            notePath: "references/local-vault-note.md",
            frontmatter: { title: "Local Vault Note" },
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
      expect(await readdir(path.join(tmpVault, "references"))).toEqual(["local-vault-note.md"]);
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
      await rm(tmpHome, { recursive: true, force: true });
    }
  });
});
