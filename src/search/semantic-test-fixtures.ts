import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function writeSemanticFixtureVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-semantic-"));
  await mkdir(path.join(vault, "references"), { recursive: true });
  await mkdir(path.join(vault, "projects"), { recursive: true });
  await writeFile(
    path.join(vault, "references", "Agent Retrieval.md"),
    `---
title: Agent Retrieval
tags:
  - agent-graph
---
# Agent Retrieval

Agent retrieval combines graph context, semantic memory, and durable evidence.
The retrieve interface should work without depending on qmd.
`,
    "utf-8",
  );
  await writeFile(
    path.join(vault, "references", "Graph Index.md"),
    `---
title: Graph Index
tags:
  - graph
---
# Graph Index

The graph index stores wikilink neighborhoods and property axes.
`,
    "utf-8",
  );
  await writeFile(
    path.join(vault, "projects", "Embedding Sync.md"),
    `---
title: Embedding Sync
tags:
  - semantic
---
# Embedding Sync

Embedding sync refreshes the native OMS semantic index for markdown notes.
`,
    "utf-8",
  );
  return vault;
}
