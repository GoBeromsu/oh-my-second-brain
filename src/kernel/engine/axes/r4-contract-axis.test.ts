import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_SCHEMA, loadContract, loadObsidianTypes, parseContract, serializeContract, writeContract } from "../../contracts/index.js";
import { buildNodeIndex } from "../graph/builder.js";
import { filterNodesByQueryAxes, type EngineGraphNode } from "../graph/node.js";
import { collectVaultAxisObservations, openAxisStore } from "./store.js";

let roots: string[] = [];

function queryNode(path: string, folder: string, axes: Record<string, unknown>): EngineGraphNode {
  return {
    path,
    concept: null,
    folder,
    axes: axes as EngineGraphNode["axes"],
    wikilinks: [],
    bodyPreview: "",
    searchTerms: new Set(),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("R4 contract and axis primitives", () => {
  it("round-trips a strict JSON contract and exposes a JSON schema", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-r4-contract-"));
    roots.push(root);
    const contract = {
      version: 1,
      intent: "Frontmatter navigation",
      axes: [{ kind: "field" as const, key: "status", type: "text" as const, allowedValues: ["active", "draft"] }],
      types: { status: "text" as const },
      allowedValues: { status: ["active", "draft"] },
    };
    await writeContract(root, contract);
    expect(parseContract(await readFile(path.join(root, ".oms", "types.json"), "utf8"))).toEqual(contract);
    expect(CONTRACT_SCHEMA.required).toEqual(["version", "axes", "types", "allowedValues"]);
    expect(() => parseContract("{\"version\":1,\"axes\":[]}")).toThrow(/types/);
    const extended = parseContract(JSON.stringify({ ...contract, custom: { owner: "user" } }));
    expect(JSON.parse(serializeContract(extended)).custom).toEqual({ owner: "user" });
  });

  it("uses Obsidian types as a read-only authority and ignores legacy YAML", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-r4-authority-"));
    roots.push(root);
    await mkdir(path.join(root, ".oms"), { recursive: true });
    await mkdir(path.join(root, ".obsidian"), { recursive: true });
    await writeFile(path.join(root, ".oms", "taxonomy.yaml"), "broken: [legacy\n", "utf8");
    await writeContract(root, {
      version: 1,
      axes: [{ kind: "field", key: "done", type: "text" }],
      types: { done: "text" },
      allowedValues: {},
    });
    await writeFile(path.join(root, ".obsidian", "types.json"), JSON.stringify({ types: { done: "checkbox" } }), "utf8");
    const authority = await loadObsidianTypes(root);
    expect(authority?.types.done).toBe("checkbox");
    expect((await loadContract(root))?.axes[0]?.type).toBe("checkbox");
    expect(await readFile(path.join(root, ".oms", "taxonomy.yaml"), "utf8")).toContain("legacy");
  });

  it("preserves number/boolean EAV values and folds case into one facet", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-r4-axis-"));
    roots.push(root);
    const store = openAxisStore(path.join(root, "axes.sqlite"));
    store.record({ notePath: "a.md", axisKey: "rating", value: 5 });
    store.record({ notePath: "a.md", axisKey: "published", value: true });
    store.record({ notePath: "a.md", axisKey: "status", value: "Active" });
    store.record({ notePath: "b.md", axisKey: "status", value: "active" });
    expect(store.list({ axisKey: "rating" })[0]?.value).toBe(5);
    expect(store.list({ axisKey: "published" })[0]?.value).toBe(true);
    expect(store.facets({ axisKey: "status" })).toHaveLength(1);
    expect(store.facets({ axisKey: "status" })[0]?.count).toBe(2);
    store.replaceNote("a.md", { rating: 7, status: "ACTIVE" }, { folder: "References" });
    expect(store.list({ notePath: "a.md" }).map((row) => row.normalizedValue)).toEqual(["7", "active", "references"]);
    store.close();
  });

  it("combines same-axis query values with OR and distinct axes with AND", () => {
    const nodes: EngineGraphNode[] = [
      queryNode("a.md", "references", { status: ["active"], rating: [4] }),
      queryNode("b.md", "references", { status: ["draft"], rating: [2] }),
      queryNode("c.md", "notes", { status: ["active"], rating: [5] }),
    ];
    const result = filterNodesByQueryAxes(nodes, {
      folder: "references",
      field: { status: ["active", "draft"], rating: { gte: 4 } },
    });
    expect(result.map((node) => node.path)).toEqual(["a.md"]);
    expect(() => filterNodesByQueryAxes(nodes, { concept: "nope" } as never)).toThrow(/Unknown query axis/);
  });

  it("reports malformed YAML instead of turning it into an empty frontmatter map", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-r4-malformed-"));
    roots.push(root);
    await writeFile(path.join(root, "broken.md"), "---\nstatus: [broken\n---\nBody\n", "utf8");
    await expect(buildNodeIndex({ vaultPath: root })).rejects.toThrow(/Malformed frontmatter/);
  });

  it("rolls back EAV publication when a later note has an invalid axis", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-r4-axis-rollback-"));
    roots.push(root);
    const store = openAxisStore(path.join(root, "axes.sqlite"));
    store.record({ notePath: "existing.md", axisKey: "status", value: "kept" });
    await writeFile(path.join(root, "first.md"), "---\nstatus: fresh\n---\n", "utf8");
    await writeFile(path.join(root, "bad.md"), "---\n\"\": invalid\n---\n", "utf8");

    await expect(collectVaultAxisObservations(root, store)).rejects.toThrow(/Axis key must be non-empty/);
    expect(store.list().map((row) => row.notePath)).toEqual(["existing.md"]);
    store.close();
  });

  it("publishes a complete EAV snapshot and removes deleted notes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-r4-axis-reconcile-"));
    roots.push(root);
    const store = openAxisStore(path.join(root, "axes.sqlite"));
    await writeFile(path.join(root, "live.md"), "---\nstatus: live\n---\n", "utf8");
    store.record({ notePath: "deleted.md", axisKey: "status", value: "stale" });

    await collectVaultAxisObservations(root, store);
    expect(store.list().map((row) => row.notePath)).toEqual(["live.md"]);
    expect(store.sourceSignature()).toMatch(/^[a-f0-9]{64}$/);
    store.close();
  });

  it("does not create a derived database when the initial scan fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-r4-axis-no-partial-"));
    roots.push(root);
    await writeFile(path.join(root, "broken.md"), "---\nstatus: [broken\n---\n", "utf8");

    await expect(collectVaultAxisObservations(root)).rejects.toThrow(/malformed frontmatter/i);
    await expect(readdir(path.join(root, ".oms"))).rejects.toThrow();
  });
});
