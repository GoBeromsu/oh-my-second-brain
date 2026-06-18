import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSemanticCli } from "./semantic.js";

let tmpVault: string | undefined;

afterEach(async () => {
  if (tmpVault) {
    await rm(tmpVault, { recursive: true, force: true });
    tmpVault = undefined;
  }
});

async function writeVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-cli-semantic-"));
  await mkdir(path.join(vault, "references"), { recursive: true });
  await writeFile(
    path.join(vault, "references", "Agent Retrieval.md"),
    `---
title: Agent Retrieval
---
# Agent Retrieval

Agent retrieval uses native OMS semantic search.
`,
    "utf-8",
  );
  return vault;
}

function jsonOutput(output: readonly string[]): Record<string, unknown> {
  const raw = output.at(-1);
  if (!raw) throw new Error("Expected JSON output.");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected JSON object output.");
  }
  return parsed;
}

describe("semantic CLI", () => {
  it("runs a lex-only sync, lexical query, and document get through the native engine", async () => {
    tmpVault = await writeVault();
    const output: string[] = [];

    // Model-less: --no-embed performs a lexical-only sync (no vectors fabricated).
    const syncCode = await runSemanticCli({
      argv: ["semantic", "sync", "--collection", "obsidian", "--no-embed"],
      vault: tmpVault,
      write: (message) => output.push(message),
    });
    expect(syncCode).toBe(0);
    expect(jsonOutput(output)).toEqual(expect.objectContaining({ available: true, storage: "oms-native-json" }));

    const queryCode = await runSemanticCli({
      argv: ["query", "--lex", "agent retrieval", "-c", "obsidian", "-n", "1"],
      vault: tmpVault,
      write: (message) => output.push(message),
    });
    expect(queryCode).toBe(0);
    const query = jsonOutput(output);
    const hits = query["hits"];
    expect(Array.isArray(hits)).toBe(true);
    const hit = Array.isArray(hits) ? hits[0] : undefined;
    if (typeof hit !== "object" || hit === null || Array.isArray(hit)) throw new Error("Expected hit object.");
    expect(hit).toEqual(expect.objectContaining({ path: "references/Agent Retrieval.md" }));
    const docid = hit["docid"];
    if (typeof docid !== "string") throw new Error("Expected docid.");

    const getCode = await runSemanticCli({
      argv: ["semantic", "get", `${docid}:4:2`, "--line-numbers"],
      vault: tmpVault,
      write: (message) => output.push(message),
    });
    expect(getCode).toBe(0);
    const single = jsonOutput(output);
    expect(single).toEqual(
      expect.objectContaining({
        available: true,
        documents: [
          expect.objectContaining({
            path: "references/Agent Retrieval.md",
            content: expect.stringContaining("# Agent Retrieval"),
          }),
        ],
      }),
    );
  });

  it("reports status, lists the engine collection, and lists contexts", async () => {
    tmpVault = await writeVault();
    const output: string[] = [];

    expect(
      await runSemanticCli({
        argv: ["semantic", "status"],
        vault: tmpVault,
        write: (message) => output.push(message),
      }),
    ).toBe(0);
    expect(jsonOutput(output)).toEqual(expect.objectContaining({ available: true, storage: "oms-native-json" }));

    expect(
      await runSemanticCli({
        argv: ["collection", "list"],
        vault: tmpVault,
        write: (message) => output.push(message),
      }),
    ).toBe(0);
    expect(jsonOutput(output)).toEqual({
      collections: [expect.objectContaining({ name: "default" })],
    });

    expect(
      await runSemanticCli({
        argv: ["context", "list"],
        vault: tmpVault,
        write: (message) => output.push(message),
      }),
    ).toBe(0);
    expect(jsonOutput(output)).toEqual(expect.objectContaining({ available: true, contexts: expect.any(Array) }));

    expect(
      await runSemanticCli({
        argv: ["semantic", "cleanup"],
        vault: tmpVault,
        write: (message) => output.push(message),
      }),
    ).toBe(0);
    expect(jsonOutput(output)).toEqual(expect.objectContaining({ available: true }));
  });
});
