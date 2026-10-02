import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import { parseNote } from "../kernel/conventions/frontmatter.js";
import { engineStorePath } from "../kernel/engine/paths.js";
import { createOMSMcpServer } from "./server.js";

vi.mock("../kernel/conventions/frontmatter.js", async importOriginal => {
  const original = await importOriginal<typeof import("../kernel/conventions/frontmatter.js")>();
  return { ...original, parseNote: vi.fn(original.parseNote) };
});

it("parses each captured source once across a cold no-index MCP query, warm reuse and edit", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "oms-cold-parse-")));
  const vault = path.join(root, "vault");
  await mkdir(vault);
  vi.stubEnv("XDG_CACHE_HOME", path.join(root, "cache"));
  const notes = [
    "---\ntitle: Declared\ntags: [one, two]\n---\n# Body\nsharedmarker\n",
    "---\ntitle: [broken\n---\n# Actual title\nsharedmarker\n",
    "---\nwhen: !!timestamp 2026-10-01T12:00:00Z\nloop: &loop [*loop]\n---\nsharedmarker\n",
  ];
  for (const [index, raw] of notes.entries()) await writeFile(path.join(vault, `${index}.md`), raw);
  const server = createOMSMcpServer({ vault, source: "explicit" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "cold-source-parsing", version: "1" });
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const query = async (text: string) => {
      const response = await client.callTool({ name: "search", arguments: { op: "query", query: text, limit: 0 } });
      const block = response.content[0];
      if (block?.type !== "text") throw new Error("Missing query response");
      return JSON.parse(block.text);
    };
    vi.mocked(parseNote).mockClear();
    expect(await query("sharedmarker")).toMatchObject({ available: true, totalCount: 3, hits: [] });
    for (const raw of notes) expect(vi.mocked(parseNote).mock.calls.filter(([input]) => input === raw)).toHaveLength(1);
    vi.mocked(parseNote).mockClear();
    expect(await query("sharedmarker")).toMatchObject({ available: true, totalCount: 3 });
    expect(vi.mocked(parseNote).mock.calls.filter(([raw]) => notes.includes(raw))).toEqual([]);
    const changed = "---\ntitle: Changed\n---\nchangedmarker\n";
    await writeFile(path.join(vault, "0.md"), changed);
    vi.mocked(parseNote).mockClear();
    expect(await query("changedmarker")).toMatchObject({ available: true, totalCount: 1 });
    expect(vi.mocked(parseNote).mock.calls.filter(([raw]) => raw === changed)).toHaveLength(1);
    for (const [index, raw] of notes.entries()) expect(await readFile(path.join(vault, `${index}.md`), "utf8")).toBe(index === 0 ? changed : raw);
    await expect(stat(engineStorePath(vault))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(vault, ".oms"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await client.close(); await server.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
});
