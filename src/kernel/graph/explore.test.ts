import { afterEach, describe, expect, it } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeMorningVaultFixture } from "../search/morning-test-fixtures.js";
import { exploreLocalGraph } from "./explore.js";

let vault: string | undefined;
afterEach(async () => { if (vault !== undefined) await rm(vault, { recursive: true, force: true }); vault = undefined; });

describe("local graph exploration", () => {
  it("expands template-axis seeds through shared fields and wikilinks", async () => {
    vault = await writeMorningVaultFixture();
    await writeFile(path.join(vault, "references/Shared Frontmatter.md"), `---
template: reference
title: Shared Frontmatter
source-url: https://example.com/shared-frontmatter
tags:
  - agent-graph
---

Connected only by shared metadata.
`);
    const result = await exploreLocalGraph({ vault, template: "reference", property: "tags", value: "agent-graph", query: "agent retrieval", limit: 1, maxNeighbors: 5, useCache: false });
    expect(result.provider).toBe("headless-scan");
    expect(result.seeds.map(node => node.path)).toEqual(["references/Agent Retrieval.md"]);
    const neighbors = result.neighbors.map(node => node.path);
    expect(neighbors).toContain("references/Shared Frontmatter.md");
    expect(neighbors).toContain("references/Graph Index.md");
    expect(neighbors).not.toContain("references/Unrelated.md");
    expect(result.neighbors.find(node => node.path === "references/Shared Frontmatter.md")?.reasons).toContainEqual({ kind: "property-value", from: "references/Agent Retrieval.md", to: "references/Shared Frontmatter.md", axis: "tags", value: "agent-graph" });
    expect(result.neighbors.find(node => node.path === "references/Graph Index.md")?.reasons).toContainEqual({ kind: "wikilink", from: "references/Agent Retrieval.md", to: "references/Graph Index.md", target: "references/Graph Index.md" });
  });
});
