import { afterEach, describe, expect, it } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeMorningVaultFixture } from "../search/morning-test-fixtures.js";
import { exploreLocalGraph } from "./explore.js";
import { existsSync } from "node:fs";
import { engineGraphCachePath, engineNodeCachePath } from "../engine/paths.js";
import { makeTracerConfig } from "../engine/tracer.js";
import { vaultCacheRoot } from "../engine/paths.js";

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
    expect(result.seeds[0]?.binding).toBe("template");
  });

  it("reaches unbound and malformed notes instead of dropping them from the neighborhood", async () => {
    vault = await writeMorningVaultFixture();
    await writeFile(path.join(vault, "references/Unbound.md"), "Plain note linking [[Agent Retrieval]] without any template.\n");
    await writeFile(path.join(vault, "references/Broken.md"), "---\ntemplate: reference\ntitle: [unclosed\n---\n\nStill links [[Agent Retrieval]].\n");
    const result = await exploreLocalGraph({ vault, wikilink: "references/Agent Retrieval.md", limit: 5, maxNeighbors: 10, useCache: false });
    const reachable = [...result.seeds, ...result.neighbors];
    const unbound = reachable.find(node => node.path === "references/Unbound.md");
    const broken = reachable.find(node => node.path === "references/Broken.md");
    expect(unbound).toMatchObject({ template: null, binding: "default", diagnostics: [] });
    expect(broken?.binding).toBe("unresolved");
    expect(broken?.template).toBeNull();
    expect(broken?.diagnostics).toContain("invalid-frontmatter");
  });

  it("reads no vault cache on a miss and agrees with the external owner", async () => {
    vault = await writeMorningVaultFixture();
    const scanned = await exploreLocalGraph({ vault, template: "reference", limit: 1, maxNeighbors: 1, useCache: false });
    expect(scanned.provider).toBe("headless-scan");
    expect(existsSync(path.join(vault, ".oms", "cache"))).toBe(false);
    expect(existsSync(engineGraphCachePath(vault))).toBe(false);
    expect(existsSync(engineNodeCachePath(vault))).toBe(false);
    expect(makeTracerConfig({ vaultPath: vault }).cacheDir).toBeUndefined();
    expect(vaultCacheRoot(vault)).toBe(path.dirname(path.dirname(engineGraphCachePath(vault))));
  });
});
