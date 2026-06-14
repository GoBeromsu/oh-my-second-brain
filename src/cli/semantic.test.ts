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
  it("syncs, queries, and gets documents through OMS native commands", async () => {
    tmpVault = await writeVault();
    const output: string[] = [];

    const syncCode = await runSemanticCli({
      argv: ["semantic", "sync", "--collection", "obsidian"],
      vault: tmpVault,
      write: (message) => output.push(message),
    });
    expect(syncCode).toBe(0);
    expect(jsonOutput(output)).toEqual(expect.objectContaining({ available: true, storage: "qmd-sqlite" }));

    const queryCode = await runSemanticCli({
      argv: ["query", "agent retrieval", "-c", "obsidian", "-n", "1"],
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
            content: expect.stringContaining("4: # Agent Retrieval"),
          }),
        ],
      }),
    );
  });

  it("lists the active native collection", async () => {
    tmpVault = await writeVault();
    const output: string[] = [];
    await runSemanticCli({
      argv: ["semantic", "collection", "add", ".", "--name", "obsidian"],
      vault: tmpVault,
      write: (message) => output.push(message),
    });

    const code = await runSemanticCli({
      argv: ["collection", "list"],
      vault: tmpVault,
      write: (message) => output.push(message),
    });

    expect(code).toBe(0);
    expect(jsonOutput(output)).toEqual({
      collections: [
        expect.objectContaining({
          name: "obsidian",
          documents: 1,
        }),
      ],
    });
  });

  it("exposes qmd-compatible native maintenance, collection, context, ls, pull, and bench commands", async () => {
    tmpVault = await writeVault();
    const output: string[] = [];

    expect(
      await runSemanticCli({
        argv: ["semantic", "init"],
        vault: tmpVault,
        write: (message) => output.push(message),
      }),
    ).toBe(0);
    expect(jsonOutput(output)).toEqual(expect.objectContaining({ available: true, initialized: true }));

    expect(
      await runSemanticCli({
        argv: [
          "semantic",
          "collection",
          "add",
          "references",
          "--name",
          "refs",
          "--pattern",
          "**/*.md",
          "--update-command",
          "git pull --ff-only",
        ],
        vault: tmpVault,
        write: (message) => output.push(message),
      }),
    ).toBe(0);

    expect(
      await runSemanticCli({
        argv: ["semantic", "context", "add", "refs/references", "Prefer retrieval notes for agent workflows."],
        vault: tmpVault,
        write: (message) => output.push(message),
      }),
    ).toBe(0);
    expect(jsonOutput(output)).toEqual(expect.objectContaining({ available: true, contexts: expect.any(Array) }));

    expect(
      await runSemanticCli({
        argv: ["semantic", "ls", "refs"],
        vault: tmpVault,
        write: (message) => output.push(message),
      }),
    ).toBe(0);
    expect(jsonOutput(output)).toEqual(
      expect.objectContaining({
        available: true,
        documents: [expect.objectContaining({ path: "references/Agent Retrieval.md", collection: "refs" })],
      }),
    );

    const fixture = path.join(tmpVault, "bench.json");
    await writeFile(
      fixture,
      JSON.stringify({ cases: [{ query: "lex: agent retr", expected: "references/Agent Retrieval.md" }] }),
      "utf-8",
    );
    expect(
      await runSemanticCli({
        argv: ["semantic", "bench", fixture, "-c", "refs"],
        vault: tmpVault,
        write: (message) => output.push(message),
      }),
    ).toBe(0);
    expect(jsonOutput(output)).toEqual(expect.objectContaining({ available: true, passed: 1, total: 1 }));

    expect(
      await runSemanticCli({
        argv: ["semantic", "pull"],
        vault: tmpVault,
        write: (message) => output.push(message),
      }),
    ).toBe(0);
    expect(jsonOutput(output)).toEqual(expect.objectContaining({ available: true, storage: "qmd-sqlite" }));

    expect(
      await runSemanticCli({
        argv: ["semantic", "doctor", "--storage", "qmd-sqlite", "--model-path", "/models/embed.gguf"],
        vault: tmpVault,
        write: (message) => output.push(message),
      }),
    ).toBe(0);
    const doctor = jsonOutput(output);
    expect(doctor).toEqual(expect.objectContaining({ available: true, checks: expect.any(Array) }));
    expect(doctor.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "GGUF embedding model",
          status: "pass",
          detail: expect.stringContaining("/models/embed.gguf"),
        }),
      ]),
    );
  });
});
