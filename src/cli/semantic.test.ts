import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isSemanticCliCommand, runSemanticCli } from "./semantic.js";
import { semanticUsageText } from "./semantic-usage.js";

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
  it("runs a lex-only sync and lexical search through the native engine", async () => {
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

    const searchCode = await runSemanticCli({
      argv: ["semantic", "search", "--lex", "agent retrieval", "-c", "obsidian", "-n", "1"],
      vault: tmpVault,
      write: (message) => output.push(message),
    });
    expect(searchCode).toBe(0);
    const search = jsonOutput(output);
    const hits = search["hits"];
    expect(Array.isArray(hits)).toBe(true);
    const hit = Array.isArray(hits) ? hits[0] : undefined;
    if (typeof hit !== "object" || hit === null || Array.isArray(hit)) throw new Error("Expected hit object.");
    expect(hit).toEqual(expect.objectContaining({ path: "references/Agent Retrieval.md" }));
  });

  it("lists the engine collection and contexts", async () => {
    tmpVault = await writeVault();
    const output: string[] = [];

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

  it.each(["query", "vsearch", "get", "multi-get", "status"])("rejects retired qmd alias %s", async (command) => {
    const errors: string[] = [];
    expect(isSemanticCliCommand(command)).toBe(false);
    await expect(
      runSemanticCli({
        argv: [command],
        vault: "/unused",
        writeError: (message) => errors.push(message),
      }),
    ).resolves.toBe(1);
    expect(errors).toEqual([semanticUsageText()]);
  });
});
