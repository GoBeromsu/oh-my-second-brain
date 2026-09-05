import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sourceSignature } from "../kernel/templates/resolver.js";
import type { Digest } from "../kernel/templates/types.js";
import { runNoteCommand } from "./note-command.js";

const roots: string[] = [];
const sha = (value: string): Digest => `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

async function vault(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "oms-note-cli-"));
  roots.push(root);
  await Promise.all([".oms", ".obsidian", "Templates", "notes"].map(dir => mkdir(path.join(root, dir), { recursive: true })));
  const policy = `${JSON.stringify({
    version: 3,
    templateFolders: [{ path: "Templates", mode: "manual", default: true }],
    defaultTemplate: "note",
    base: { fields: {} },
    contracts: { note: { intent: "note", fields: {}, views: [] } },
    templates: {
      note: {
        templateId: "note",
        destinationClass: "registered-existing",
        renderer: "obsidian-core",
        sourceFolder: "Templates",
        sourcePath: "Templates/note.md",
        contract: "note",
        naming: "{{slug}}.md",
      },
    },
  })}\n`;
  const taxonomy = JSON.stringify({ folders: { notes: { concept: "note", template: "note" } } });
  const obsidian = "{\"title\":\"text\"}\n";
  const template = "---\ntitle: template\n---\nTemplate body\n";
  const descriptors = [
    { logicalId: "template-policy", signature: sha(policy) },
    { logicalId: "taxonomy", signature: sha(taxonomy) },
    { logicalId: "obsidian-types", signature: sha(obsidian) },
    { path: "Templates/note.md", signature: sha(template) },
  ];
  const projection = `${JSON.stringify({
    version: "oms.types.v1",
    generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(descriptors), sources: descriptors },
    managed: {
      base: { fields: {} },
      globalAxes: {},
      templates: {
        note: {
          templateId: "note",
          destinationClass: "registered-existing",
          renderer: "obsidian-core",
          sourcePath: "Templates/note.md",
          targetFolder: "notes",
          keyOrder: ["title"],
          fields: { title: { type: "text" } },
          views: [],
          naming: "{{slug}}.md",
          bodySignature: sha("Template body\n"),
        },
      },
    },
  }, null, 2)}\n`;
  await Promise.all([
    writeFile(path.join(root, ".oms", "template-policy.json"), policy),
    writeFile(path.join(root, ".oms", "taxonomy.json"), taxonomy),
    writeFile(path.join(root, ".oms", "types.json"), projection),
    writeFile(path.join(root, ".obsidian", "types.json"), obsidian),
    writeFile(path.join(root, "Templates", "note.md"), template),
  ]);
  return root;
}

function output(): any {
  return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
}

beforeEach(() => {
  process.exitCode = undefined;
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  log.mockRestore();
  error.mockRestore();
  process.exitCode = undefined;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("note command", () => {
  it("creates with the declared default and appends and updates a real signed-vault note", async () => {
    const root = await vault();
    await runNoteCommand(["create", "--vault", root, "--frontmatter", "{\"title\":\"Hello\"}", "--body", "First"]);
    expect(output()).toMatchObject({ status: "written", notePath: "notes/hello.md", receipt: { mode: "create", postconditionVerified: true } });

    await runNoteCommand(["append", "notes/hello.md", "--vault", root, "--body", "Second"]);
    expect(output()).toMatchObject({ status: "written", receipt: { mode: "append", postconditionVerified: true } });

    await runNoteCommand(["update", "notes/hello.md", "--vault", root, "--frontmatter", "{\"title\":\"Updated\"}", "--body", "Replacement"]);
    expect(output()).toMatchObject({ status: "written", receipt: { mode: "update", postconditionVerified: true } });
    expect(await readFile(path.join(root, "notes", "hello.md"), "utf8")).toContain("Replacement");
    expect(process.exitCode).toBe(0);
  });

  it("reads single, multi, and window documents without creating the engine store", async () => {
    const root = await vault();
    await writeFile(path.join(root, "notes", "a.md"), "one\ntwo\nthree\n");
    await writeFile(path.join(root, "notes", "b.md"), "other\n");

    await runNoteCommand(["get", "notes/a.md", "--vault", root]);
    expect(output()).toMatchObject({ available: true, documents: [{ path: "notes/a.md" }] });
    await runNoteCommand(["get", "notes/a.md", "notes/b.md", "--vault", root]);
    expect(output().documents).toHaveLength(2);
    await runNoteCommand(["get", "--note-path", "notes/a.md", "--from-line", "2", "--line-count", "1", "--vault", root]);
    expect(output().documents[0].content).toBe("two");
    expect(existsSync(path.join(root, ".oms", "engine-store.sqlite"))).toBe(false);
  });

  it("audits and guards one-note backfill with dry-run and exact approval", async () => {
    const root = await vault();
    const notePath = path.join(root, "notes", "legacy.md");
    const original = "---\nconcept: note\ncustom: keep\n---\nbody\n";
    await writeFile(notePath, original);

    await runNoteCommand(["audit", "--vault", root, "--folder", "notes", "--max-per-template", "1", "--json"]);
    expect(output()).toMatchObject({ folder: "notes", status: "needs-repair" });

    await runNoteCommand(["backfill", "notes/legacy.md", "--vault", root, "--dry-run"]);
    const planned = output();
    expect(planned).toMatchObject({ status: "planned", approvalDigest: expect.stringMatching(/^sha256:/u) });
    expect(await readFile(notePath, "utf8")).toBe(original);

    await runNoteCommand(["backfill", "notes/legacy.md", "--vault", root]);
    expect(output()).toMatchObject({ status: "rejected" });
    expect(await readFile(notePath, "utf8")).toBe(original);

    await runNoteCommand(["backfill", "notes/legacy.md", "--vault", root, "--yes", "--approved-digest", planned.approvalDigest]);
    expect(output()).toMatchObject({ status: "applied", markerState: "complete" });
    expect(await readFile(notePath, "utf8")).toContain("template: note");
  });

  it("rejects mutually exclusive content sources, selectors, and unknown flags", async () => {
    const root = await vault();
    await runNoteCommand(["create", "note", "--vault", root, "--body", "x", "--body-file", "x.md"]);
    expect(output()).toMatchObject({ status: "rejected" });
    await runNoteCommand(["get", "notes/a.md", "--note-path", "notes/a.md", "--from-line", "1", "--vault", root]);
    expect(output()).toMatchObject({ status: "rejected" });
    await runNoteCommand(["audit", "--vault", root, "--bogus"]);
    expect(output()).toMatchObject({ status: "rejected" });
  });
});
