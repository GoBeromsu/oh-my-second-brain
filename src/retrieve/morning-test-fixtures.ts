import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function writeMorningVaultFixture(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-morning-"));
  await mkdir(path.join(vault, "references"), { recursive: true });
  await writeFile(
    path.join(vault, "references", "Agent Retrieval.md"),
    `---
title: Agent Retrieval
source-url: https://example.com/agent-retrieval
tags:
  - agent-graph
---

Agent retrieval follows [[Graph Index]] and combines semantic evidence with graph context.
`,
    "utf-8",
  );
  await writeFile(
    path.join(vault, "references", "Graph Index.md"),
    `---
title: Graph Index
source-url: https://example.com/graph-index
tags:
  - agent-graph
---

Index note for graph neighborhoods.
`,
    "utf-8",
  );
  await writeFile(
    path.join(vault, "references", "Unrelated.md"),
    `---
title: Unrelated
tags:
  - archive
---

Agent retrieval outside the selected graph should only appear for global semantic fusion.
`,
    "utf-8",
  );
  return vault;
}
