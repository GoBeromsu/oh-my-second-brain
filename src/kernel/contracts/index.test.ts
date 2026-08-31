import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadObsidianTypes, parseTemplatePolicy, serializeTemplatePolicy } from "./index.js";

let vault: string | undefined;
afterEach(async () => { if (vault !== undefined) await rm(vault, { recursive: true, force: true }); vault = undefined; });

describe("Obsidian property type authority", () => {
  it("is read-only and returns null when the authority is absent", async () => {
    vault = await mkdtemp(path.join(tmpdir(), "oms-types-authority-"));
    expect(await loadObsidianTypes(vault)).toBeNull();
    expect(await readFile(vault).catch(() => null)).toBeNull();
  });

  it("reads map and descriptor-array forms without changing bytes", async () => {
    vault = await mkdtemp(path.join(tmpdir(), "oms-types-authority-"));
    await mkdir(path.join(vault, ".obsidian"));
    const target = path.join(vault, ".obsidian", "types.json");
    const raw = JSON.stringify({ types: { title: "text", done: { type: "checkbox" } }, extension: true });
    await writeFile(target, raw);
    expect(await loadObsidianTypes(vault)).toMatchObject({ types: { title: "text", done: "checkbox" }, source: target });
    expect(await readFile(target, "utf8")).toBe(raw);
    await writeFile(target, JSON.stringify({ types: [{ name: "rating", type: "number" }] }));
    expect((await loadObsidianTypes(vault))?.types).toEqual({ rating: "number" });
  });

  it("re-exports the template policy parser rather than a writable projection contract", () => {
    const policy = parseTemplatePolicy({ version: 1, templateFolder: "Templates", base: { fields: {} }, contracts: {}, templates: {}, extension: { owner: "vault" } });
    expect(JSON.parse(serializeTemplatePolicy(policy))).toMatchObject({ version: 1, extensions: { extension: { owner: "vault" } } });
  });
});
