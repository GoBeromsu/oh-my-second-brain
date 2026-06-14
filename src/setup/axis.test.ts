import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";
import {
  collectObservedFields,
  mergeObservedFieldsIntoConcept,
  parseLensDefinitions,
} from "./axis.js";
import type { Concept } from "../ontology/types.js";

let tmpVault: string | undefined;

afterEach(async () => {
  if (tmpVault) {
    await rm(tmpVault, { recursive: true, force: true });
    tmpVault = undefined;
  }
});

async function makeVault(): Promise<string> {
  tmpVault = await mkdtemp(path.join(tmpdir(), "oms-axis-"));
  await writeFile(
    path.join(tmpVault, "references.md"),
    "# root file ignored by folder resolver\n",
    "utf-8",
  );
  await writeFile(
    path.join(tmpVault, ".hidden.md"),
    "---\nsecret: true\n---\n",
    "utf-8",
  );
  await writeFile(path.join(tmpVault, "README.txt"), "status: draft\n", "utf-8");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(path.join(tmpVault ?? "", "references"), { recursive: true }),
  );
  await writeFile(
    path.join(tmpVault, "references", "source.md"),
    [
      "---",
      "title: Clean Architecture",
      "source-url: https://example.com/book",
      "tags:",
      "  - architecture",
      "published: 2017-09-01",
      "rating: 5",
      "reviewed: true",
      "---",
      "# Source",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(
    path.join(tmpVault, "references", "broken.md"),
    "---\nnot: [closed\n---\n# Broken",
    "utf-8",
  );
  return tmpVault;
}

describe("setup axis discovery", () => {
  it("SETUP-AXIS-003 summarizes observed frontmatter fields without mutating notes", async () => {
    const vault = await makeVault();
    const before = await readFile(path.join(vault, "references", "source.md"), "utf-8");

    const summaries = await collectObservedFields({ vault });
    const after = await readFile(path.join(vault, "references", "source.md"), "utf-8");
    const references = summaries.find((summary) => summary.folder === "references");

    expect(after).toBe(before);
    expect(references?.fields.map((field) => [field.name, field.type])).toEqual([
      ["published", "date"],
      ["rating", "number"],
      ["reviewed", "boolean"],
      ["source-url", "url"],
      ["tags", "list"],
      ["title", "string"],
    ]);
    expect(references?.warnings).toHaveLength(1);
  });

  it("SETUP-AXIS-004 rejects lenses that reference unknown fields", () => {
    expect(() => parseLensDefinitions("synthesis:title,missing", new Set(["title"]))).toThrow(
      /unknown field "missing"/,
    );
  });

  it("merges observed fields into a concept without duplicating existing fields", () => {
    const concept: Concept = {
      concept: "literature",
      intent: "Processed references",
      folder: "references",
      fields: [
        {
          name: "title",
          type: "string",
          required: true,
          intent: "Title",
        },
      ],
      lenses: [],
    };

    const next = mergeObservedFieldsIntoConcept(concept, [
      { name: "title", type: "string", count: 2 },
      { name: "tags", type: "list", count: 1 },
    ]);

    expect(next.fields.map((field) => field.name)).toEqual(["title", "tags"]);
    expect(yamlParse(JSON.stringify(next))).toBeDefined();
  });
});
