import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as contracts from "./index.js";
import { isObsidianTag, parseObsidianTypes, readObsidianTypes } from "./index.js";

let vault: string | undefined;
afterEach(async () => { if (vault !== undefined) await rm(vault, { recursive: true, force: true }); vault = undefined; });

describe("contracts facade", () => {
  it("re-exports only the Obsidian type authority, never template policy", () => {
    expect(Object.keys(contracts).sort()).toEqual(["FIELD_TYPES", "isFieldType", "isObsidianTag", "parseObsidianTypes", "readObsidianTypes"]);
  });

  it("reads .obsidian/types.json read-only and treats absence as no declared types", async () => {
    vault = await mkdtemp(path.join(tmpdir(), "oms-types-authority-"));
    expect(await readObsidianTypes(vault)).toEqual({});
    expect(await readdir(vault)).toEqual([]);
    await mkdir(path.join(vault, ".obsidian"));
    const target = path.join(vault, ".obsidian", "types.json");
    const raw = JSON.stringify({ types: { title: "text", done: "checkbox", odd: "hologram" } });
    await writeFile(target, raw);
    expect(await readObsidianTypes(vault)).toEqual({ title: "text", done: "checkbox" });
    expect(await readFile(target, "utf8")).toBe(raw);
  });

  it("rejects non-object roots and validates tag shapes", () => {
    expect(() => parseObsidianTypes("[]")).toThrow(/OBSIDIAN_TYPES_INVALID/);
    expect(parseObsidianTypes("{}")).toEqual({});
    expect(isObsidianTag("project/active")).toBe(true);
    expect(isObsidianTag("/leading")).toBe(false);
    expect(isObsidianTag("123")).toBe(false);
  });
});
