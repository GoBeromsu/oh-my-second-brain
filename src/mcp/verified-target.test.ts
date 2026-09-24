import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeContractVault } from "../kernel/templates/approved-vault-fixture.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");

const LITERATURE_MARKDOWN = "---\ntemplate: literature\ntitle: Untitled\nsource-url:\n---\n\n# Literature\n";

async function createTemplateAuthority(vault: string): Promise<void> {
  await writeContractVault(vault, {
    properties: {
      title: { type: "text", intent: "Note title." },
      "source-url": { type: "text", intent: "Where the source came from." },
    },
    templates: {
      literature: {
        fields: ["title", "source-url"],
        approvedMarkdown: LITERATURE_MARKDOWN,
        targetFolder: "references",
      },
    },
    folders: { references: { intent: "Processed sources." } },
    obsidianTypes: { title: "text", "source-url": "text" },
  });
  await mkdir(path.join(vault, "references"), { recursive: true });
}

function textPayload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  const text = block.type === "text" ? block.text : "{}";
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error(text); }
}

describe("Issue #58: Verified-target admission", () => {
  let tmpHome: string;
  let tmpDocuments: string;
  let tmpVault: string;

  afterEach(async () => {
    for (const dir of [tmpHome, tmpDocuments, tmpVault]) {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
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

      const guide = textPayload(await client.callTool({
        name: "write",
        arguments: { op: "guide", notePath: "references/rejected-note.md", templateId: "literature" },
      }));
      expect(guide.state).toBe("rejected");
      expect((guide.rejection as Record<string, unknown>).code).toBe("SELECTION_INVALID");
      expect((guide.rejection as Record<string, unknown>).message).toContain("current directory");

      const check = textPayload(await client.callTool({
        name: "write",
        arguments: { op: "check", connectionId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222" },
      }));
      expect(check.state).toBe("rejected");
      expect(typeof check.rejection).toBe("object");

      // The inferred directory gained nothing.
      expect((await readdir(tmpDocuments)).length).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("guides an environment-resolved vault and reports its resolution source", async () => {
    tmpHome = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-home-")));
    tmpDocuments = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-docs-")));
    tmpVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-vault-")));
    await createTemplateAuthority(tmpVault);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp"],
      cwd: tmpDocuments,
      env: { HOME: tmpHome, OMS_VAULT: tmpVault, PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const guide = textPayload(await client.callTool({
        name: "write",
        arguments: { op: "guide", notePath: "references/new-note.md", templateId: "literature" },
      }));
      expect(guide.state).toBe("selected");
      expect(guide.resolvedVault).toBe(tmpVault);
      expect(guide.resolutionSource).toBe("env");
      // Selection returns the user's own source text and an effective contract;
      // it writes no note bytes.
      const selected = guide.selected as { readonly source: { readonly text: string } | null; readonly binding: { readonly contractDigest: string } };
      expect(selected.source?.text).toBe(LITERATURE_MARKDOWN);
      expect(selected.binding.contractDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      const locator = guide.locator as { readonly connectionId: string; readonly sessionId: string };
      await expect(readFile(path.join(tmpVault, "references", "new-note.md"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });

      // The agent saves the note, then OMS checks the bytes on disk.
      await writeFile(
        path.join(tmpVault, "references", "new-note.md"),
        "---\ntemplate: literature\ntitle: Response Test\n---\n\n# Literature\n\nBody.\n",
      );
      const check = textPayload(await client.callTool({
        name: "write",
        arguments: { op: "check", connectionId: locator.connectionId, sessionId: locator.sessionId },
      }));
      expect(check.resolvedVault).toBe(tmpVault);
      expect(check.resolutionSource).toBe("env");
      const result = check.result as { readonly structural: string; readonly semantic: string; readonly violations: readonly { readonly field?: string }[] };
      expect(result.structural).toBe("fail");
      expect(result.semantic).toBe("not-evaluated");
      expect(result.violations.map(violation => violation.field)).toContain("source-url");
    } finally {
      await client.close();
    }
  });

  it("does not advertise a retired note-write operation", async () => {
    tmpHome = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-home-")));
    tmpVault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-test-vault-")));
    await createTemplateAuthority(tmpVault);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "serve", "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      env: { HOME: tmpHome, PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);
      const write = (await client.listTools()).tools.find(tool => tool.name === "write");
      expect(JSON.stringify(write?.inputSchema)).not.toContain('"note"');
      const rejected = await client.callTool({
        name: "write",
        arguments: { op: "note", mode: "create", templateId: "literature", body: "Must not be written." },
      });
      const text = rejected.content[0]?.type === "text" ? rejected.content[0].text : "";
      expect(text).toContain("Unknown operation");
      expect((await readdir(path.join(tmpVault, "references"))).length).toBe(0);
    } finally {
      await client.close();
    }
  });
});
