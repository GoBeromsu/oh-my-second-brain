import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveEffectiveVault } from "../kernel/link/link.js";
import { writeGlobalConfig } from "../kernel/link/global-config.js";
import { writeNote } from "../kernel/capture/safe.js";
import { resolveActiveOntology } from "../kernel/ontology/active.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");

// Minimal ontology fixture matching server.test.ts / link.test.ts patterns
async function createMinimalOntology(vaultPath: string): Promise<void> {
  await mkdir(path.join(vaultPath, ".oms", "concepts"), { recursive: true });
  await writeFile(
    path.join(vaultPath, ".oms", "taxonomy.yaml"),
    "version: 1\nfolders:\n  references:\n    concept: literature\n",
    "utf-8",
  );
  await writeFile(
    path.join(vaultPath, ".oms", "concepts", "literature.yaml"),
    `concept: literature
intent: External sources worth revisiting.
folder: references
fields:
  - name: title
    type: string
    required: true
    intent: Human-readable title.
  - name: source-url
    type: string
    required: true
    intent: Source URL.
`,
    "utf-8",
  );
}

function textPayload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  return JSON.parse(block.type === "text" ? block.text : "{}") as Record<string, unknown>;
}

describe("Issue #58: Verified-target write kernel", () => {
  let tmpHome: string;
  let tmpDocuments: string;
  let tmpVault: string;

  afterEach(async () => {
    if (tmpHome) {
      await rm(tmpHome, { recursive: true, force: true });
    }
    if (tmpDocuments) {
      await rm(tmpDocuments, { recursive: true, force: true });
    }
    if (tmpVault) {
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("(1) resolveEffectiveVault from fake Documents cwd with global config returns vault + source:global", async () => {
    tmpHome = await mkdtemp(path.join(tmpdir(), "oms-test-home-"));
    tmpDocuments = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-docs-")));
    tmpVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-vault-")));

    // Create minimal ontology in vault
    await createMinimalOntology(tmpVault);

    // Write global config pointing to vault
    await writeGlobalConfig({ version: 1, vault: tmpVault }, tmpHome);

    // Resolve from Documents cwd (has no .oms) with tmp homeDir
    const resolved = await resolveEffectiveVault(tmpDocuments, {}, { homeDir: tmpHome });

    expect(resolved.vault).toBe(tmpVault);
    expect(resolved.source).toBe("global");
    expect(resolved.scope).toBeNull();
  });

  it("(2) MCP write via server with global config lands note in vault, zero files in Documents", async () => {
    tmpHome = await mkdtemp(path.join(tmpdir(), "oms-test-home-"));
    tmpDocuments = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-docs-")));
    tmpVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-vault-")));

    // Create minimal ontology in vault
    await createMinimalOntology(tmpVault);

    // Write global config pointing to vault
    await writeGlobalConfig({ version: 1, vault: tmpVault }, tmpHome);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp"],
      cwd: tmpDocuments,
      env: { HOME: tmpHome, PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      const docsBefore = await readdir(tmpDocuments);
      expect(docsBefore.length).toBe(0);

      await client.connect(transport);

      const write = textPayload(
        await client.callTool({
          name: "oms_write",
          arguments: {
            mode: "create",
            notePath: "references/verified-note.md",
            frontmatter: {
              title: "Verified Global Route",
              "source-url": "https://example.com/verified",
            },
            body: "Written via global config, lands in vault, not Documents.",
          },
        }),
      );

      expect(write.status).toBe("written");
      expect(write.resolvedVault).toBe(tmpVault);
      expect(write.resolutionSource).toBe("global");
      expect(write.receipt).toBeDefined();
      expect((write.receipt as Record<string, unknown>).postconditionVerified).toBe(true);

      // Assert note exists in vault
      const noteInVault = path.join(tmpVault, "references", "verified-note.md");
      const vaultRefs = await readdir(path.join(tmpVault, "references"));
      expect(vaultRefs).toContain("verified-note.md");

      // Assert Documents dir gained zero files
      const docsAfter = await readdir(tmpDocuments);
      expect(docsAfter.length).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("(3) no global config + Documents cwd: write rejected with target-unverified, zero files", async () => {
    tmpHome = await mkdtemp(path.join(tmpdir(), "oms-test-home-"));
    tmpDocuments = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-docs-")));

    // No vault, no global config, empty HOME

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp"],
      cwd: tmpDocuments,
      env: { HOME: tmpHome, PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      const docsBefore = await readdir(tmpDocuments);
      expect(docsBefore.length).toBe(0);

      await client.connect(transport);

      const write = textPayload(
        await client.callTool({
          name: "oms_write",
          arguments: {
            mode: "create",
            notePath: "references/rejected-note.md",
            frontmatter: {
              title: "Should Be Rejected",
              "source-url": "https://example.com/rejected",
            },
            body: "Must not be written.",
          },
        }),
      );

      expect(write.status).toBe("rejected");
      expect(write.rejection).toBeDefined();
      expect((write.rejection as Record<string, unknown>).stage).toBe("admission");
      expect((write.rejection as Record<string, unknown>).code).toBe("target-unverified");
      expect((write.rejection as Record<string, unknown>).recoverable).toBe(true);
      expect((write.rejection as Record<string, unknown>).remediation).toContain("oms setup");
      expect(write.receipt).toBeUndefined();

      // Assert Documents dir gained zero files
      const docsAfter = await readdir(tmpDocuments);
      expect(docsAfter.length).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("(3b) global config pointing at directory WITHOUT .oms ontology: rejected with target-invalid", async () => {
    tmpHome = await mkdtemp(path.join(tmpdir(), "oms-test-home-"));
    tmpDocuments = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-docs-")));
    tmpVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-vault-")));

    // Create vault directory WITHOUT .oms ontology (stale registry pointer)
    // tmpVault exists but has no .oms/

    // Write global config pointing to vault without .oms
    await writeGlobalConfig({ version: 1, vault: tmpVault }, tmpHome);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp"],
      cwd: tmpDocuments,
      env: { HOME: tmpHome, PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      const docsBefore = await readdir(tmpDocuments);
      expect(docsBefore.length).toBe(0);

      await client.connect(transport);

      const write = textPayload(
        await client.callTool({
          name: "oms_write",
          arguments: {
            mode: "create",
            notePath: "references/invalid-target.md",
            frontmatter: {
              title: "Invalid Target",
              "source-url": "https://example.com/invalid",
            },
            body: "Must not be written.",
          },
        }),
      );

      expect(write.status).toBe("rejected");
      expect(write.rejection).toBeDefined();
      expect((write.rejection as Record<string, unknown>).stage).toBe("admission");
      expect((write.rejection as Record<string, unknown>).code).toBe("target-invalid");
      expect((write.rejection as Record<string, unknown>).recoverable).toBe(false);
      expect(write.receipt).toBeUndefined();

      // Assert zero files created anywhere
      const docsAfter = await readdir(tmpDocuments);
      expect(docsAfter.length).toBe(0);
      const vaultAfter = await readdir(tmpVault);
      expect(vaultAfter.length).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("(4) precedence: OMS_VAULT env beats global; explicit source passthrough via writeNote", async () => {
    tmpHome = await mkdtemp(path.join(tmpdir(), "oms-test-home-"));
    tmpDocuments = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-docs-")));
    const globalVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-global-")));
    const envVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-env-")));

    // Create ontologies in both
    await createMinimalOntology(globalVault);
    await createMinimalOntology(envVault);

    // Write global config pointing to globalVault
    await writeGlobalConfig({ version: 1, vault: globalVault }, tmpHome);

    // Case A: Env beats global via resolveEffectiveVault
    const envResolved = await resolveEffectiveVault(tmpDocuments, { OMS_VAULT: envVault }, { homeDir: tmpHome });
    expect(envResolved.source).toBe("env");
    expect(envResolved.vault).toBe(envVault);

    // Case B: Explicit source passthrough in writeNote accepts bare tmpdir with source:explicit
    const bareDir = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-bare-")));
    const activeOntology = await resolveActiveOntology(envVault);
    const result = await writeNote({
      target: { vault: bareDir, source: "explicit" },
      ontology: activeOntology.ontology,
      mode: "create",
      dryRun: false,
      notePath: "references/explicit-note.md",
      frontmatter: {
        title: "Explicit Vault",
        "source-url": "https://example.com/explicit",
      },
      body: "Written with explicit source.",
    });

    expect(result.status).toBe("written");
    expect(result.receipt).toBeDefined();
    expect((result.receipt as Record<string, unknown>).resolutionSource).toBe("explicit");

    // Cleanup extra vaults
    await rm(globalVault, { recursive: true, force: true });
    await rm(bareDir, { recursive: true, force: true });
    tmpVault = envVault;
  });

  it("(5) every write response exposes resolvedVault + resolutionSource in written and rejected shapes", async () => {
    tmpHome = await mkdtemp(path.join(tmpdir(), "oms-test-home-"));
    tmpDocuments = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-docs-")));
    tmpVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-vault-")));

    // Create minimal ontology in vault
    await createMinimalOntology(tmpVault);

    // Write global config pointing to vault
    await writeGlobalConfig({ version: 1, vault: tmpVault }, tmpHome);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp"],
      cwd: tmpDocuments,
      env: { HOME: tmpHome, PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      // Case A: Written response with receipt
      const written = textPayload(
        await client.callTool({
          name: "oms_write",
          arguments: {
            mode: "create",
            notePath: "references/response-test.md",
            frontmatter: {
              title: "Response Test",
              "source-url": "https://example.com/response",
            },
            body: "Testing response shape.",
          },
        }),
      );

      expect(written.status).toBe("written");
      expect(written.resolvedVault).toBe(tmpVault);
      expect(written.resolutionSource).toBe("global");
      expect(written.receipt).toBeDefined();
      expect((written.receipt as Record<string, unknown>).resolvedVault).toBe(tmpVault);
      expect((written.receipt as Record<string, unknown>).resolutionSource).toBe("global");

      // Case B: Rejected response (ask status - contract violation)
      const rejected = textPayload(
        await client.callTool({
          name: "oms_write",
          arguments: {
            mode: "create",
            notePath: "references/incomplete.md",
            frontmatter: {
              title: "Incomplete",
              // Missing source-url - required field
            },
            body: "Body present",
          },
        }),
      );

      expect(rejected.status).toBe("ask");
      expect(rejected.resolvedVault).toBe(tmpVault);
      expect(rejected.resolutionSource).toBe("global");
      expect(rejected.missingFields).toContain("source-url");
    } finally {
      await client.close();
    }
  });
});
