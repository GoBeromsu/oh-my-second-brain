import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TemplateWriteContract } from "../conventions/write-contract.js";
import { writeResolvedTemplateNote } from "./safe.js";

const contract: TemplateWriteContract = {
  fields: [
    { name: "title", type: "string", required: true, normalize: "trim" },
    { name: "source-url", type: "url", required: true, format: "url" },
    { name: "status", type: "string", allowedValues: ["draft", "published"] },
  ],
  additionalProperties: "preserve",
};

let vault = "";

afterEach(async () => {
  if (vault !== "") await rm(vault, { recursive: true, force: true });
  vault = "";
});

function input(mode: "create" | "append" | "update", overrides: Record<string, unknown> = {}) {
  return {
    target: { vault, source: "explicit" as const },
    template: { contract, folder: "notes" },
    mode,
    dryRun: false,
    notePath: "notes/example.md",
    frontmatter: { title: " Example ", "source-url": "https://example.com", unknown: "kept" },
    body: "First body.",
    ...overrides,
  };
}

describe("writeResolvedTemplateNote", () => {
  it("creates a normalized note while preserving undeclared frontmatter", async () => {
    vault = await mkdtemp(path.join(os.tmpdir(), "oms-template-safe-"));
    const result = await writeResolvedTemplateNote(input("create"));
    expect(result.status).toBe("written");
    expect(result.frontmatter).toMatchObject({ title: "Example", unknown: "kept" });
    expect(await readFile(path.join(vault, "notes/example.md"), "utf-8")).toContain("unknown: kept");
  });

  it("rejects an invalid URL before writing", async () => {
    vault = await mkdtemp(path.join(os.tmpdir(), "oms-template-safe-"));
    const result = await writeResolvedTemplateNote(input("create", { frontmatter: { title: "Example", "source-url": "not-a-url" } }));
    expect(result.status).toBe("rejected");
    expect(result.violations).toContainEqual(expect.objectContaining({ field: "source-url", rule: "format" }));
  });

  it("uses one separator when appending a body that starts with a separator", async () => {
    vault = await mkdtemp(path.join(os.tmpdir(), "oms-template-safe-"));
    await writeResolvedTemplateNote(input("create"));
    const result = await writeResolvedTemplateNote(input("append", { frontmatter: {}, body: "\nSecond body." }));
    expect(result.status).toBe("written");
    expect(await readFile(path.join(vault, "notes/example.md"), "utf-8")).toContain("First body.\n\nSecond body.");
  });

  it("updates only supplied values and keeps existing frontmatter and body", async () => {
    vault = await mkdtemp(path.join(os.tmpdir(), "oms-template-safe-"));
    await writeResolvedTemplateNote(input("create"));
    const result = await writeResolvedTemplateNote(input("update", { frontmatter: { status: "draft" }, body: undefined }));
    expect(result.status).toBe("written");
    expect(result.frontmatter).toMatchObject({ title: "Example", unknown: "kept", status: "draft" });
  });

  it("has dry-run parity without creating the note", async () => {
    vault = await mkdtemp(path.join(os.tmpdir(), "oms-template-safe-"));
    const result = await writeResolvedTemplateNote(input("create", { dryRun: true }));
    expect(result).toMatchObject({ status: "written", notePath: "notes/example.md", receipt: undefined });
    await expect(readFile(path.join(vault, "notes/example.md"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never selects a fallback placement", async () => {
    vault = await mkdtemp(path.join(os.tmpdir(), "oms-template-safe-"));
    const result = await writeResolvedTemplateNote(input("create", { notePath: undefined, template: { contract } }));
    expect(result).toMatchObject({ status: "rejected", notePath: "" });
  });

  it("preserves an existing note for all write modes", async () => {
    vault = await mkdtemp(path.join(os.tmpdir(), "oms-template-safe-"));
    await writeResolvedTemplateNote(input("create"));
    const append = await writeResolvedTemplateNote(input("append", { frontmatter: {}, body: "More." }));
    const update = await writeResolvedTemplateNote(input("update", { frontmatter: { status: "published" }, body: "Replacement." }));
    expect(append.status).toBe("written");
    expect(update.status).toBe("written");
    expect(await readFile(path.join(vault, "notes/example.md"), "utf-8")).toContain("Replacement.");
  });
});
