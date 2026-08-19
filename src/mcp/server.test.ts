import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { harnessSurfaceRegistry } from "../harness/surface-registry.js";

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
      const retrieveTool = tools.tools.find((tool) => tool.name === "oms_retrieve_context");
      expect(JSON.stringify(retrieveTool?.inputSchema)).toContain("semanticMinScore");
      // storage/modelPath knobs were removed from the schemas (engine uses explicit env config).
      expect(JSON.stringify(retrieveTool?.inputSchema)).not.toContain("semanticStorage");
      expect(JSON.stringify(retrieveTool?.inputSchema)).not.toContain("semanticModelPath");
      expect(retrieveTool?.annotations?.readOnlyHint).toBe(false);
      const semanticStatusTool = tools.tools.find((tool) => tool.name === "oms_semantic_status");
      expect(JSON.stringify(semanticStatusTool?.inputSchema)).toContain("index");
      expect(JSON.stringify(semanticStatusTool?.inputSchema)).not.toContain("storage");
      const semanticQueryTool = tools.tools.find((tool) => tool.name === "oms_semantic_query");
      expect(JSON.stringify(semanticQueryTool?.inputSchema)).toContain("query");
      expect(JSON.stringify(semanticQueryTool?.inputSchema)).not.toContain("modelPath");
      const getTool = tools.tools.find((tool) => tool.name === "oms_get_document");
      expect(getTool?.annotations?.readOnlyHint).toBe(true);
      expect(getTool?.annotations?.destructiveHint).toBe(false);
      const auditTool = tools.tools.find((tool) => tool.name === "oms_vault_audit");
      expect(auditTool?.annotations?.readOnlyHint).toBe(true);
      expect(JSON.stringify(auditTool?.inputSchema)).toContain("folder");

      const status = await client.callTool({ name: "oms_graph_status", arguments: {} });
      const parsedStatus = textPayload(status);
      expect(parsedStatus.writeTools).toBe("write-gated-by-verified-target-and-contract");
      const writeTool = tools.tools.find((tool) => tool.name === "write");
      expect(writeTool?.annotations?.readOnlyHint).toBe(false);
      expect(JSON.stringify(writeTool?.inputSchema)).toContain("update");
      expect(parsedStatus.counts.concepts).toBeGreaterThan(0);
      const derivedState = parsedStatus.derivedState as Record<string, unknown>;
      const staleness = derivedState.staleness as Record<string, unknown>;
      expect(staleness.graphStale).toBe(true);

      const validation = await client.callTool({
        name: "oms_validate_contract",
        arguments: { notePath: "references/clean-architecture.md" },
      });
      const parsedValidation = textPayload(validation);
      expect(parsedValidation.valid).toBe(true);
      expect(parsedValidation.concept).toBe("literature");
      const audit = await client.callTool({
        name: "oms_vault_audit",
        arguments: { folder: "references" },
      });
      const parsedAudit = textPayload(audit);
      expect(parsedAudit.clean).toBe(true);
      expect(parsedAudit.scannedNotes).toBe(1);
      expect(parsedAudit.excludedNotes).toBe(0);
      const nonStringFolderAudit = await client.callTool({
        name: "oms_vault_audit",
        arguments: { folder: 123 },
      });
      expect(nonStringFolderAudit.isError).toBe(true);
      expect(nonStringFolderAudit.content[0]?.type === "text" ? nonStringFolderAudit.content[0].text : "").toContain(
        'Argument "folder" must be a string',
      );

      const missingVaultFolderAudit = await client.callTool({
        name: "oms_vault_audit",
        arguments: { folder: "inbox" },
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
          name: "oms_retrieve_context",
          arguments: {
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

      const status = textPayload(await client.callTool({ name: "oms_graph_status", arguments: {} }));
      expect(status.ontologySource).toBe("vault-invalid");
      expect(status.writeTools).toBe("disabled-invalid-ontology");

      const write = await client.callTool({
        name: "write",
        arguments: {
          notePath: "references/unsafe.md",
          frontmatter: {
            title: "Should not write",
            "source-url": "https://example.com/should-not-write",
          },
          body: "Should not write.",
          mode: "create",
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
      expect(textPayload(await client.callTool({ name: "oms_graph_status", arguments: {} })).ontologySource).toBe(
        "bundled",
      );

      await client.callTool({ name: "oms_graph_build", arguments: {} });

      expect(textPayload(await client.callTool({ name: "oms_graph_status", arguments: {} })).ontologySource).toBe(
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

      const status = textPayload(await client.callTool({ name: "oms_graph_status", arguments: {} }));
      expect(status.ontologySource).toBe("vault-invalid");
      expect(status.writeTools).toBe("disabled-invalid-ontology");

      const write = await client.callTool({
        name: "write",
        arguments: {
          notePath: "references/unsafe.md",
          frontmatter: {
            title: "Should not write",
            "source-url": "https://example.com/should-not-write",
          },
          body: "Should not write.",
          mode: "create",
        },
      });
      expect(write.isError).toBe(true);
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
          name: "write",
          arguments: {
            mode: "create",
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
          name: "write",
          arguments: {
            mode: "create",
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
          name: "write",
          arguments: {
            mode: "update",
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

      const status = textPayload(await client.callTool({ name: "oms_graph_status", arguments: {} }));
      expect(status.writeTools).toBe("write-disabled-target-unverified");

      const write = textPayload(
        await client.callTool({
          name: "write",
          arguments: {
            mode: "create",
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

      const status = textPayload(await client.callTool({ name: "oms_graph_status", arguments: {} }));
      expect(status.writeTools).toBe("write-gated-by-verified-target-and-contract");

      const created = textPayload(
        await client.callTool({
          name: "write",
          arguments: {
            mode: "create",
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
