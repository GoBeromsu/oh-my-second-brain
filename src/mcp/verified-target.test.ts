import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeResolvedTemplateNote } from "../kernel/capture/safe.js";
import { loadResolvedTemplates, sourceSignature } from "../kernel/templates/index.js";
import type { SourceDescriptor } from "../kernel/templates/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function createTemplateAuthority(vault: string): Promise<void> {
  const policy = JSON.stringify({ version: 3, templateFolders: [{ path: "Templates/OMS", mode: "manual", default: true }], base: { fields: {} }, contracts: { literature: { intent: "A source.", fields: { template: { type: "text", required: true }, title: { type: "text", required: true }, "source-url": { type: "text", required: true } }, views: [] } }, templates: { literature: { templateId: "literature", destinationClass: "managed-default", sourceFolder: "Templates/OMS", sourcePath: "Templates/OMS/literature.md", contract: "literature", naming: "{{slug}}.md" } } });
  const taxonomy = JSON.stringify({ folders: {}, templates: { literature: { templateFolder: "Inbox" } } });
  const obsidianTypes = JSON.stringify({ types: { template: "text", title: "text", "source-url": "text" } });
  const template = "---\ntemplate: literature\ntitle: Untitled\nsource-url:\n---\n# Literature\n<!-- oms:content -->\n";
  const sources: SourceDescriptor[] = [
    { logicalId: "template-policy", signature: digest(policy) },
    { logicalId: "taxonomy", signature: digest(taxonomy) },
    { logicalId: "obsidian-types", signature: digest(obsidianTypes) },
    { path: "Templates/OMS/literature.md", signature: digest(template) },
  ];
  const projection = JSON.stringify({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sources), sources }, managed: { base: { fields: {} }, globalAxes: {}, templates: { literature: { templateId: "literature", destinationClass: "managed-default", sourcePath: "Templates/OMS/literature.md", targetFolder: "Inbox", keyOrder: ["template", "title", "source-url"], fields: { template: { type: "text", required: true }, title: { type: "text", required: true }, "source-url": { type: "text", required: true } }, views: [], naming: "{{slug}}.md", bodySignature: digest("# Literature\n<!-- oms:content -->\n") } } } });
  await Promise.all([mkdir(path.join(vault, ".oms"), { recursive: true }), mkdir(path.join(vault, ".obsidian"), { recursive: true }), mkdir(path.join(vault, "Templates", "OMS"), { recursive: true })]);
  await Promise.all([writeFile(path.join(vault, ".oms", "template-policy.json"), policy), writeFile(path.join(vault, ".oms", "taxonomy.json"), taxonomy), writeFile(path.join(vault, ".oms", "types.json"), projection), writeFile(path.join(vault, ".obsidian", "types.json"), obsidianTypes), writeFile(path.join(vault, "Templates", "OMS", "literature.md"), template)]);
}

function textPayload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  const text = block.type === "text" ? block.text : "{}";
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error(text); }
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

  it("(3) Documents cwd with no vault, bridge, or OMS_VAULT: write rejected with target-unverified, zero files", async () => {
    tmpHome = await mkdtemp(path.join(tmpdir(), "oms-test-home-"));
    tmpDocuments = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-docs-")));

    // No vault, no bridge, no OMS_VAULT, empty HOME

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
          name: "write",
          arguments: {
            op: "note",
            mode: "create",
            templateId: "literature",
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

  it("(4) explicit source passthrough via the template writer", async () => {
    const envVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-env-")));
    const bareDir = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-bare-")));
    await createTemplateAuthority(bareDir);
    const result = await writeResolvedTemplateNote({
      target: { vault: bareDir, source: "explicit" },
      convention: await loadResolvedTemplates(bareDir),
      templateId: "literature",
      mode: "create",
      dryRun: false,
      frontmatter: { title: "Explicit Vault", "source-url": "https://example.com/explicit" },
      body: "Written with explicit source.",
    });

    expect(result.status).toBe("written");
    expect(result.receipt).toBeDefined();
    expect((result.receipt as Record<string, unknown>).resolutionSource).toBe("explicit");

    // Cleanup extra vaults
    await rm(bareDir, { recursive: true, force: true });
    tmpVault = envVault;
  });

  it("(5) every write response exposes resolvedVault + resolutionSource in written and rejected shapes", async () => {
    tmpHome = await mkdtemp(path.join(tmpdir(), "oms-test-home-"));
    tmpDocuments = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-docs-")));
    tmpVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-vault-")));

    // Legacy direct-kernel coverage still needs its ontology; MCP note writes use the template authority.
    await createTemplateAuthority(tmpVault);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp"],
      cwd: tmpDocuments,
      env: { HOME: tmpHome, OMS_VAULT: tmpVault, PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      // Case A: Written response with receipt
      const written = textPayload(
        await client.callTool({
          name: "write",
          arguments: {
            op: "note",
            mode: "create",
            templateId: "literature",
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
      expect(written.resolutionSource).toBe("env");
      expect(written.receipt).toBeDefined();
      expect((written.receipt as Record<string, unknown>).resolvedVault).toBe(tmpVault);
      expect((written.receipt as Record<string, unknown>).resolutionSource).toBe("env");

      // Case B: Rejected response (ask status - contract violation)
      const rejected = textPayload(
        await client.callTool({
          name: "write",
          arguments: {
            op: "note",
            mode: "create",
            templateId: "literature",
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
      expect(rejected.resolutionSource).toBe("env");
      expect((rejected.violations as Array<Record<string, unknown>>).some((item) => item.field === "source-url" && item.rule === "required")).toBe(true);
    } finally {
      await client.close();
    }
  });
});
