import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOMSMcpServer } from "./server.js";

it("uses an exact MCP path read for ifMatch and refuses a stale read without overwriting", async () => {
  const vault = await realpath(await mkdtemp(path.join(tmpdir(), "oms-read-edit-")));
  const notePath = "note.md";
  const filename = path.join(vault, notePath);
  const original = "# Original\r\nExact source bytes.\r\n";
  await writeFile(filename, original);
  const server = createOMSMcpServer({ vault, source: "explicit" });
  const client = new Client({ name: "read-edit-journey", version: "0.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    const block = response.content[0];
    if (block?.type !== "text") throw new Error("Missing tool response");
    return { response, payload: JSON.parse(block.text) as Record<string, unknown> };
  };
  const read = async () => {
    const { response, payload } = await call("search", { path: notePath });
    expect(response.isError).toBeFalsy();
    expect(payload.available).toBe(true);
    const [document] = payload.documents as Array<{ path: string; content: string; revision: string }>;
    expect(document!.path).toBe(notePath);
    expect(document!.revision).toBe(`sha256:${createHash("sha256").update(document!.content).digest("hex")}`);
    return document!;
  };
  try {
    await server.connect(right); await client.connect(left);
    const first = await read();
    expect(first.content).toBe(original);
    const updated = "# Updated\nRead before edit.\n";
    const saved = await call("write", { path: first.path, content: updated, ifMatch: first.revision });
    expect(saved.response.isError).toBeFalsy();
    expect(saved.payload).toMatchObject({ ok: true, path: notePath });
    expect(await readFile(filename, "utf8")).toBe(updated);
    const current = await read();
    expect(current.revision).toBe(saved.payload.revision);
    expect(current.revision).not.toBe(first.revision);

    await writeFile(filename, "# External edit\nKeep this newer source.\n");
    const stale = await call("write", { path: current.path, content: "Must not replace newer bytes.\n", ifMatch: current.revision });
    expect(stale.response.isError).toBe(true);
    expect(stale.payload).toMatchObject({ ok: false, code: "WRITE_TARGET_CHANGED", retryable: true });
    expect(await readFile(filename, "utf8")).toBe("# External edit\nKeep this newer source.\n");
    const refreshed = await read();
    expect(refreshed.content).toBe("# External edit\nKeep this newer source.\n");
    expect(refreshed.revision).not.toBe(current.revision);
  } finally { await client.close(); await server.close(); await rm(vault, { recursive: true, force: true }); }
});
