import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { digestBytes } from "../templates/canonical.js";
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
    const policy = parseTemplatePolicy({
      version: 4,
      properties: {},
      default: {
        templatePath: ".oms/templates/default.md",
        approvedMarkdown: "",
        approvedMarkdownDigest: digestBytes(""),
        fields: {},
        headings: [],
        semanticCriteria: [],
      },
      templates: {},
      extension: { owner: "vault" },
    });
    // Unknown members are preserved, not stripped.
    expect(JSON.parse(serializeTemplatePolicy(policy))).toMatchObject({ version: 4, extensions: { extension: { owner: "vault" } } });
  });

  it("refuses a version 3 policy instead of migrating it", () => {
    expect(() => parseTemplatePolicy({ version: 3, base: { fields: {} }, contracts: {}, templates: {} }))
      .toThrow(/TEMPLATE_POLICY_VERSION_UNSUPPORTED/);
  });
});
