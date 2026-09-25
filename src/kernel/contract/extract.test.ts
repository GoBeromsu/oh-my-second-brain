import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyVariable, extractTemplate } from "./extract.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-contract-extract-"));
  roots.push(root);
  return root;
}

async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), content);
}

describe("classifyVariable", () => {
  it("recognises core variables and treats the rest as free", () => {
    expect(classifyVariable("{{title}}")).toBe("title");
    expect(classifyVariable("{{date}}")).toBe("date");
    expect(classifyVariable("{{date:YYYY-MM-DD}}")).toBe("date");
    expect(classifyVariable("{{date:YYYY-MM-DDTHH:mm}}")).toBe("datetime");
    expect(classifyVariable("{{time}}")).toBe("free");
    expect(classifyVariable("<% tp.date.now() %>")).toBe("free");
  });
});

describe("extractTemplate", () => {
  it("infers field types, literals and variables without running the template", async () => {
    const root = await vault();
    await put(root, "Templates/Meeting.md", [
      "---",
      "created: \"{{date}}\"",
      "updated: \"{{date:YYYY-MM-DD HH:mm}}\"",
      "name: \"{{title}}\"",
      "mixed: \"On {{date}}\"",
      "run: \"<% tp.file.title %>\"",
      "tags: [meeting]",
      "aliases: []",
      "status: open",
      "score: 3",
      "done: false",
      "due: 2024-05-01",
      "at: 2024-05-01T10:00",
      "people: [a, b]",
      "mixedList: [a, 1]",
      "---",
      "# {{title}}",
      "## Agenda",
      "Notes",
      "-----",
      "```",
      "# Not a heading",
      "```",
    ].join("\n"));
    const result = await extractTemplate(root, "Templates/Meeting.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byName = Object.fromEntries(result.extraction.fields.map(field => [field.name, field]));
    expect(result.extraction.fields.map(field => field.name)).toEqual([
      "aliases", "at", "created", "done", "due", "mixed", "mixedList", "name", "people", "run", "score", "status", "tags", "updated",
    ]);
    expect(byName["created"]).toEqual({ name: "created", inferredType: "date", literal: null, variable: "date" });
    expect(byName["updated"]).toMatchObject({ inferredType: "datetime", variable: "datetime" });
    expect(byName["name"]).toMatchObject({ inferredType: "text", variable: "title", literal: null });
    expect(byName["mixed"]).toMatchObject({ inferredType: "text", variable: "free" });
    expect(byName["run"]).toMatchObject({ variable: "free" });
    expect(byName["tags"]).toEqual({ name: "tags", inferredType: "tags", literal: ["meeting"], variable: null });
    expect(byName["aliases"]).toMatchObject({ inferredType: "aliases", literal: [] });
    expect(byName["status"]).toMatchObject({ inferredType: "text", literal: "open" });
    expect(byName["score"]).toMatchObject({ inferredType: "number", literal: 3 });
    expect(byName["done"]).toMatchObject({ inferredType: "checkbox", literal: false });
    expect(byName["due"]).toMatchObject({ inferredType: "date", literal: "2024-05-01" });
    expect(byName["at"]).toMatchObject({ inferredType: "datetime" });
    expect(byName["people"]).toMatchObject({ inferredType: "multitext", literal: ["a", "b"] });
    expect(byName["mixedList"]).toMatchObject({ inferredType: "list", literal: ["a", 1] });
    expect(result.extraction.headings).toEqual([
      { title: "{{title}}", level: 1, variable: true },
      { title: "Agenda", level: 2, variable: false },
      { title: "Notes", level: 2, variable: false },
    ]);
    expect(result.extraction.sourceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("reuses the same variable token in several fields", async () => {
    const root = await vault();
    await put(root, "T.md", "---\na: \"{{date}}\"\nb: \"{{date}}\"\n---\n");
    const result = await extractTemplate(root, "T.md");
    expect(result.ok && result.extraction.fields.map(field => field.variable)).toEqual(["date", "date"]);
  });

  it("reports a missing source and malformed YAML, and creates nothing", async () => {
    const root = await vault();
    const missing = await extractTemplate(root, "Templates/None.md");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.diagnostics[0]?.code).toBe("TEMPLATE_SOURCE_MISSING");
    await put(root, "Bad.md", "---\na: [\n---\nbody\n");
    const bad = await extractTemplate(root, "Bad.md");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.length).toBeGreaterThan(0);
    expect((await readdir(root)).sort()).toEqual(["Bad.md"]);
  });

  it("accepts a template without frontmatter", async () => {
    const root = await vault();
    await put(root, "Plain.md", "# Only\n");
    const result = await extractTemplate(root, "Plain.md");
    expect(result.ok && result.extraction).toMatchObject({ fields: [], headings: [{ title: "Only", level: 1, variable: false }] });
  });
});
