/**
 * `search` must not write.
 *
 * The tool is annotated `readOnlyHint: true`, which is a promise to every MCP
 * host that calling it is safe on an untouched vault. This suite verifies the
 * promise the only way that actually proves it: by snapshotting the whole vault
 * tree, calling every advertised `search` operation, and requiring the tree
 * to come back byte-identical.
 *
 * It deliberately does NOT enumerate the specific writes we know about
 * (`.oms/`, `engine-store.sqlite`, `-wal`, `-shm`). Naming them would only prove
 * that the four writes we already found stopped, and would stay silent about a
 * fifth. Comparing the entire tree catches any write, including one added later
 * by a change that has nothing to do with this fix.
 */
import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { writeApprovedVault } from "../kernel/templates/approved-vault-fixture.js";
import { engineStorePath } from "../kernel/engine/paths.js";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { omsMcpTools } from "./server.js";

interface ToolResult {
  readonly content: { type: string; text?: string }[];
  readonly isError?: boolean;
}

function rawText(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

function textPayload(result: ToolResult): Record<string, unknown> {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  return JSON.parse(block?.text ?? "{}") as Record<string, unknown>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");

/**
 * Every operation the `search` schema advertises, with arguments valid for
 * each, including the template identity listing. Derived from the live tool schema rather than hand-listed, so an
 * operation added later cannot quietly escape the read-only guarantee.
 */
function advertisedSearchOperations(): { op: string; args: Record<string, unknown> }[] {
  const search = omsMcpTools.find((tool) => tool.name === "search");
  const schema = search?.inputSchema as {
    readonly oneOf?: readonly {
      readonly properties?: Record<string, { readonly const?: string }>;
    }[];
  };
  const ops = (schema.oneOf ?? [])
    .map((branch) => branch.properties?.["op"]?.const)
    .filter((op): op is string => typeof op === "string");
  expect(JSON.stringify(search?.inputSchema)).not.toContain("concept");

  // Arguments that satisfy each operation's required fields. Anything not
  // listed here takes the bare `{ op }` form.
  const argsByOp: Record<string, Record<string, unknown>> = {
    "template-scan": {},
    templates: {},
    query: { mode: "query", query: "alpha" },
    "index-status": { view: "status" },
    "get-document": { target: "notes/alpha.md" },
    context: { query: "alpha" },
  };

  return ops.map((op) => ({ op, args: { op, ...(argsByOp[op] ?? {}) } }));
}

/** Recursive content digest of every file under `root`, keyed by relative path. */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        snapshot.set(`${rel}/`, "<dir>");
        await walk(full);
      } else {
        const [body, meta] = await Promise.all([readFile(full), stat(full)]);
        snapshot.set(rel, `${createHash("sha256").update(body).digest("hex")}:${meta.size}`);
      }
    }
  }

  await walk(root);
  return snapshot;
}

function diff(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [rel, digest] of after) {
    const previous = before.get(rel);
    if (previous === undefined) changes.push(`created: ${rel}`);
    else if (previous !== digest) changes.push(`modified: ${rel}`);
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) changes.push(`deleted: ${rel}`);
  }
  return changes.sort();
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function makeVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-readonly-"));
  await mkdir(path.join(vault, "notes"), { recursive: true });
  await writeFile(
    path.join(vault, "notes", "alpha.md"),
    "---\nconcept: Project\nstatus: active\n---\n# Alpha\n\nAlpha links to [[beta]] and mentions retrieval.\n",
    "utf-8",
  );
  await writeFile(
    path.join(vault, "notes", "beta.md"),
    "---\nconcept: Project\nstatus: active\n---\n# Beta\n\nBeta discusses semantic search and graphs.\n",
    "utf-8",
  );
  return vault;
}

async function makeTemplateVault(): Promise<string> {
  const vault = await makeVault();
  await Promise.all([
    mkdir(path.join(vault, ".oms"), { recursive: true }),
    mkdir(path.join(vault, ".obsidian"), { recursive: true }),
    mkdir(path.join(vault, "Templates", "OMS"), { recursive: true }),
  ]);
  await writeApprovedVault(vault, {
    properties: { title: { type: "text", intent: "Note title." } },
    templates: {
      note: {
        fields: ["title"],
        optionalFields: ["title"],
        approvedMarkdown: "---\ntemplate: note\n---\n\nBody\n",
        rawSource: { path: "Templates/OMS/note.md", identity: "note-source", bytes: "---\ntemplate: note\n---\n" },
        targetFolder: "notes",
      },
    },
    folders: { notes: { intent: "Working notes." } },
    obsidianTypes: { title: "text" },
  });
  return vault;
}

/**
 * Runs the real `oms mcp` binary against `vault`.
 *
 * HOME is redirected to an empty directory so this test's resolution is
 * self-contained and doesn't depend on anything in the developer's environment,
 * which would make every assertion below pass or fail for reasons unrelated to
 * writing.
 *
 * `OMS_VAULT` makes the vault a verified write target. That is deliberate: it
 * means the search path is permitted to write and still must not. A cwd-inferred
 * target would have writes rejected by the admission layer anyway, so a clean
 * tree would prove nothing about `search`'s own behaviour.
 */
async function withClient<T>(vault: string, run: (client: Client) => Promise<T>): Promise<T> {
  const emptyHome = await mkdtemp(path.join(tmpdir(), "oms-readonly-home-"));
  homes.push(emptyHome);
  const cacheHome = process.env["XDG_CACHE_HOME"];
  if (cacheHome === undefined || cacheHome.length === 0) {
    throw new Error("XDG_CACHE_HOME must be the isolated test cache");
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distCli, "serve", "mcp"],
    cwd: vault,
    env: { HOME: emptyHome, OMS_VAULT: vault, PATH: process.env["PATH"] ?? "", XDG_CACHE_HOME: cacheHome },
    stderr: "pipe",
  });
  const client = new Client({ name: "oms-readonly-probe", version: "0.0.0" });
  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function holdUncheckpointedWal(vault: string): Database.Database {
  const writer = new Database(engineStorePath(vault), { fileMustExist: true });
  writer.pragma("journal_mode = WAL");
  writer.pragma("wal_autocheckpoint = 0");
  writer.prepare("UPDATE engine_meta SET updated_at = ? WHERE id = 1").run("2026-09-06T00:00:00.000Z");
  return writer;
}

const vaults: string[] = [];
const homes: string[] = [];

describe("search read-only guarantee", () => {
  beforeAll(() => () =>
    Promise.all(
      [...vaults, ...homes].map((dir) => rm(dir, { recursive: true, force: true })),
    ));

  it("declares itself read-only", () => {
    const search = omsMcpTools.find((tool) => tool.name === "search");
    expect(search?.annotations?.readOnlyHint).toBe(true);
  });

  it("lists resolved templates without mutating a valid template vault", async () => {
    const vault = await makeTemplateVault();
    vaults.push(vault);
    const before = await snapshotTree(vault);
    const result = await withClient(vault, (client) =>
      client.callTool({ name: "search", arguments: { op: "templates" } }),
    );
    const payload = textPayload(result);
    expect(payload["templates"]).toMatchObject([{
      templateId: "note",
      fields: { title: { property: "title", intent: "Note title." } },
    }]);
    // The always-on default layer is reported beside the individual templates.
    expect(payload["default"]).toMatchObject({ contractDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) });
    expect(payload["axes"]).toMatchObject({
      globalAxes: [{
        key: "folder",
        members: ["notes"],
        extensions: { intents: { notes: "Working notes." } },
      }],
    });
    expect(diff(before, await snapshotTree(vault))).toEqual([]);
  });

  /**
   * `readOnlyHint: true` is a promise about what the tool CAN do, not about
   * what a particular call happens to do. The search surface previously took
   * `embeddingSyncBeforeSearch`, which routed through to `syncEmbeddings` and
   * let any caller turn a read into a write by passing one flag.
   *
   * Removing it is the reason the annotation is allowed to be true, so the
   * schema is pinned here. Re-adding a write knob to this tool must break a
   * test rather than quietly invalidate the annotation above.
   */
  it("advertises no parameter that would let a caller trigger a write", () => {
    const search = omsMcpTools.find((tool) => tool.name === "search");
    const schema = JSON.stringify(search?.inputSchema ?? {});

    for (const knob of [
      "embeddingSyncBeforeSearch",
      "embeddingSyncForce",
      "embeddingSyncEmbed",
      "syncBeforeSearch",
    ]) {
      expect(schema, `search must not advertise ${knob}`).not.toContain(knob);
    }

    // Guard against a vacuous pass: the schema must still be the real one.
    expect(schema).toContain('"const":"query"');
    expect(schema).not.toContain('"const":"semantic-query"');
    expect(schema).not.toContain('"const":"axis"');
    expect(schema).toContain("get-document");

    // The capability moved rather than vanished, so doctor must still offer it.
    const doctor = omsMcpTools.find((tool) => tool.name === "doctor");
    expect(JSON.stringify(doctor?.inputSchema ?? {})).toContain("sync-embeddings");
    expect(doctor?.annotations?.readOnlyHint).toBe(false);
  });

  it("leaves a vault with no .oms directory completely untouched", async () => {
    const vault = await makeVault();
    vaults.push(vault);

    const operations = advertisedSearchOperations();
    // Guard against a vacuous pass: if the schema stops advertising operations,
    // an empty loop would trivially leave the tree unchanged.
    expect(operations.length).toBeGreaterThanOrEqual(9);

    const before = await snapshotTree(vault);

    const failures: string[] = [];
    await withClient(vault, async (client) => {
      for (const { op, args } of operations) {
        try {
          await client.callTool({ name: "search", arguments: args });
        } catch (error) {
          // A missing index must degrade to a structured unavailable result,
          // not a transport-level throw.
          failures.push(`${op}: ${(error as Error).message}`);
        }
      }
    });

    const after = await snapshotTree(vault);

    expect(diff(before, after)).toEqual([]);
    expect(failures).toEqual([]);

  }, 120_000);

  /**
   * Writing nothing is only half the requirement. Before this change, a search
   * on a fresh vault worked because it silently built the index on disk; the
   * obvious way to stop the writing is to stop answering, which trades a
   * correctness bug for a worse product.
   *
   * A user who installs, points a host at a vault and asks a question must get
   * an answer, not an instruction to go run a command first. The whole vault
   * snapshot above proves nothing was written; this proves the answer survived.
   */
  it("answers a first search on a vault that has never been indexed", async () => {
    const vault = await makeVault();
    vaults.push(vault);

    const payload = await withClient(vault, async (client) =>
      textPayload(
        await client.callTool({
          name: "search",
          arguments: { op: "query", mode: "query", query: "retrieval", limit: 1 },
        }),
      ),
    );

    expect(payload["available"]).toBe(true);
    expect(payload["totalCount"]).toBeGreaterThan(0);
    expect(payload["facets"] === undefined || Array.isArray(payload["facets"])).toBe(true);
    expect(payload["cursor"] === null || typeof payload["cursor"] === "string").toBe(true);
    expect(payload["receipt"]).toEqual(expect.objectContaining({
      usedChannels: expect.any(Array),
      approximated: expect.any(Boolean),
      indexDrift: expect.any(Boolean),
    }));
    const hits = (payload["hits"] as { path?: string }[] | undefined) ?? [];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.path === "notes/alpha.md")).toBe(true);

    // And it still wrote nothing while doing it.
    expect(await snapshotTree(vault).then((tree) => [...tree.keys()].sort())).toEqual([
      "notes/",
      "notes/alpha.md",
      "notes/beta.md",
    ]);
  }, 120_000);

  /**
   * The read-only search engine and the creating doctor engine must not share
   * a memoisation slot. If they do, whichever tool runs first decides what the
   * other one gets: a search on an unindexed vault would poison the slot with a
   * read-only engine and the repair that follows would refuse to build the
   * index it exists to build.
   *
   * This ordering is the realistic one. A user points a host at a fresh vault,
   * the assistant searches, finds nothing, and then runs the repair.
   */
  it("lets a repair build the index after a search has already been served", async () => {
    const vault = await makeVault();
    vaults.push(vault);

    // Serve a search first, then repair, then search again in the same MCP
    // session. What matters is that the search path has resolved and memoised
    // its engine: a read-only engine must not land in the slot the repair reuses.
    const hitPayload = await withClient(vault, async (client) => {
      const served = await client.callTool({ name: "search", arguments: { op: "query", mode: "query", query: "alpha" } });
      expect(textPayload(served)["available"]).toBe(true);

      const repaired = await client.callTool({ name: "doctor", arguments: { op: "sync-embeddings", mode: "sync" } });
      // Surface the server's own message on failure. Parsing first would throw on
      // the error path, which reports a JSON syntax error instead of the reason
      // the repair was refused.
      expect(repaired.isError ?? false, rawText(repaired as ToolResult)).toBe(false);
      expect(textPayload(repaired as ToolResult)["available"]).toBe(true);

      const hits = await client.callTool({ name: "search", arguments: { op: "query", mode: "query", query: "alpha" } });
      return textPayload(hits);
    });

    const tree = await snapshotTree(vault);
    const storePath = engineStorePath(vault);
    const writer = holdUncheckpointedWal(vault);
    try {
      const external = await snapshotTree(path.dirname(storePath));
      expect([...external.keys()].some((rel) => rel.includes(path.basename(storePath)))).toBe(true);
      expect([...external.keys()].some((rel) => rel === `${path.basename(storePath)}-wal`)).toBe(true);
      expect([...external.keys()].some((rel) => rel === `${path.basename(storePath)}-shm`)).toBe(true);
      expect([...tree.keys()].some((rel) => rel.includes("engine-store.sqlite"))).toBe(false);
    } finally {
      writer.close();
    }

    expect(hitPayload["available"]).toBe(true);
    expect((hitPayload["hits"] as unknown[] | undefined)?.length ?? 0).toBeGreaterThan(0);
  }, 180_000);

  it("still answers every operation once the index exists, and writes nothing then either", async () => {
    const vault = await makeVault();
    vaults.push(vault);

    // Build the index through the write surface that is allowed to create it.
    await withClient(vault, async (client) => {
      await client.callTool({
        name: "doctor",
        arguments: { op: "sync-embeddings", mode: "sync" },
      });
    });

    const storePath = engineStorePath(vault);
    const writer = holdUncheckpointedWal(vault);
    try {
      const before = await snapshotTree(vault);
      const externalBefore = await snapshotTree(path.dirname(storePath));
      // The index must actually exist, otherwise the read path below is being
      // measured against the same absent-store case as the previous test.
      expect([...externalBefore.keys()].some((rel) => rel.includes(path.basename(storePath)))).toBe(true);
      expect([...externalBefore.keys()].some((rel) => rel === `${path.basename(storePath)}-wal`)).toBe(true);
      expect([...externalBefore.keys()].some((rel) => rel === `${path.basename(storePath)}-shm`)).toBe(true);
      expect([...before.keys()].some((rel) => rel.includes("engine-store.sqlite"))).toBe(false);

      const hits = await withClient(vault, async (client) => {
        for (const { args } of advertisedSearchOperations()) {
          await client.callTool({ name: "search", arguments: args });
        }
        return textPayload(
          await client.callTool({
            name: "search",
            arguments: { op: "query", mode: "query", query: "alpha" },
          }),
        );
      });

      const after = await snapshotTree(vault);
      expect(diff(before, after)).toEqual([]);
      expect(diff(externalBefore, await snapshotTree(path.dirname(storePath)))).toEqual([]);

      // Without this, "make every search return unavailable" would satisfy both
      // read-only tests while destroying the feature. Search must still answer.
      expect(hits["available"]).toBe(true);
      expect((hits["hits"] as unknown[] | undefined)?.length ?? 0).toBeGreaterThan(0);
    } finally {
      writer.close();
    }
  }, 180_000);
});
