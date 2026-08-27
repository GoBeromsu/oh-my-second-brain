import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadContract,
  loadObsidianTypes,
  parseContract,
  serializeContract,
  writeContract,
} from "../index.js";

let vault: string | undefined;

afterEach(async () => {
  if (vault !== undefined) await rm(vault, { recursive: true, force: true });
  vault = undefined;
});

describe("frontmatter JSON contract", () => {
  it("round-trips unknown contract, axis, and vocabulary properties", () => {
    const contract = parseContract({
      version: 4,
      extension: { owner: "vault" },
      axes: [{
        kind: "field",
        key: "status",
        type: "select",
        renderer: "badge",
        allowedValues: [{ value: "active", color: "green" }],
      }],
      types: {},
      allowedValues: {},
    });

    expect(JSON.parse(serializeContract(contract))).toMatchObject({
      extension: { owner: "vault" },
      axes: [{ renderer: "badge", allowedValues: [{ value: "active", color: "green" }] }],
    });
  });

  it("uses .oms/types.json as the writable authority and reads Obsidian types without writing them", async () => {
    vault = await mkdtemp(path.join(tmpdir(), "oms-contract-"));
    await mkdir(path.join(vault, ".oms"), { recursive: true });
    await mkdir(path.join(vault, ".obsidian"), { recursive: true });
    await writeFile(path.join(vault, ".oms", "taxonomy.yaml"), "version: 999\n", "utf-8");
    await writeFile(path.join(vault, ".obsidian", "types.json"), JSON.stringify({ status: "checkbox" }), "utf-8");

    expect(await loadContract(vault)).toBeNull();

    await writeContract(vault, {
      version: 4,
      axes: [{ kind: "field", key: "status", type: "select" }],
      types: {},
      allowedValues: {},
    });

    expect(await loadContract(vault)).toMatchObject({ types: { status: "checkbox" } });
    expect(await loadObsidianTypes(vault)).toEqual({
      types: { status: "checkbox" },
      source: path.join(vault, ".obsidian", "types.json"),
    });
    expect(await readFile(path.join(vault, ".obsidian", "types.json"), "utf-8")).toBe(JSON.stringify({ status: "checkbox" }));
  });
});
