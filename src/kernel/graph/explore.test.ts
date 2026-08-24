import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOntology } from "../ontology/loader.js";
import { exploreLocalGraph } from "./explore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../");
const ontologyDir = path.join(repoRoot, "core", "ontology");

let tmpVault: string | undefined;

afterEach(async () => {
  if (tmpVault) {
    await rm(tmpVault, { recursive: true, force: true });
    tmpVault = undefined;
  }
});

describe("local graph exploration", () => {
  it("expands axis-ranked seeds through shared frontmatter values and wikilinks", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-local-graph-"));
    await mkdir(path.join(tmpVault, "references"), { recursive: true });
    await mkdir(path.join(tmpVault, "notes"), { recursive: true });

    await writeFile(
      path.join(tmpVault, "references", "Agent Retrieval.md"),
      `---
title: Agent Retrieval
source-url: https://example.com/agent-retrieval
tags:
  - agent-graph
  - retrieval
---

Agent retrieval should follow the local graph. See [[Graph Index]].
`,
      "utf-8",
    );
    await writeFile(
      path.join(tmpVault, "references", "Shared Frontmatter.md"),
      `---
title: Shared Frontmatter
source-url: https://example.com/shared-frontmatter
tags:
  - agent-graph
---

This note is connected only by shared metadata.
`,
      "utf-8",
    );
    await writeFile(
      path.join(tmpVault, "notes", "Graph Index.md"),
      `---
tags:
  - index
---

This index is linked from an agent note.
`,
      "utf-8",
    );
    await writeFile(
      path.join(tmpVault, "references", "Unrelated.md"),
      `---
title: Unrelated
source-url: https://example.com/unrelated
tags:
  - unrelated
---

Unconnected retrieval vocabulary should not be enough for graph-neighbor inclusion.
`,
      "utf-8",
    );

    const ontology = await loadOntology(ontologyDir);
    const result = await exploreLocalGraph({
      vault: tmpVault,
      ontology,
      property: "tags",
      value: "agent-graph",
      query: "agent retrieval",
      limit: 1,
      maxNeighbors: 5,
      useCache: false,
    });

    expect(result.provider).toBe("headless-scan");
    expect(result.seeds.map((node) => node.path)).toEqual(["references/Agent Retrieval.md"]);

    const neighborPaths = result.neighbors.map((node) => node.path);
    expect(neighborPaths).toContain("references/Shared Frontmatter.md");
    expect(neighborPaths).toContain("notes/Graph Index.md");
    expect(neighborPaths).not.toContain("references/Unrelated.md");

    const sharedFrontmatter = result.neighbors.find(
      (node) => node.path === "references/Shared Frontmatter.md",
    );
    expect(sharedFrontmatter?.reasons).toContainEqual({
      kind: "property-value",
      from: "references/Agent Retrieval.md",
      to: "references/Shared Frontmatter.md",
      axis: "tags",
      value: "agent-graph",
    });

    const graphIndex = result.neighbors.find((node) => node.path === "notes/Graph Index.md");
    expect(graphIndex?.reasons).toContainEqual({
      kind: "wikilink",
      from: "references/Agent Retrieval.md",
      to: "notes/Graph Index.md",
      target: "Graph Index",
    });
  });
});
