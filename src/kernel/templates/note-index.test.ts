import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTemplateNoteIndex,
  queryTemplateAxis,
  queryTemplateLexically,
  TEMPLATE_NOTE_INDEX_VERSION,
} from "./note-index.js";
import type { Digest, ResolvedConvention } from "./types.js";

const roots: string[] = [];
const signature = "sha256:0000000000000000000000000000000000000000000000000000000000000000" as Digest;
const staleSignature = "sha256:1111111111111111111111111111111111111111111111111111111111111111" as Digest;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function convention(): ResolvedConvention {
  return {
    base: { fields: {} },
    inputSignature: signature,
    managedSourcePaths: ["Templates/OMS/note.md"],
    globalAxes: {
      folders: { kind: "folder", key: "folder", type: "select", members: ["notes"] },
      links: { kind: "link", key: "related", type: "list", members: [] },
    },
    templates: {
      note: {
        id: "note",
        destinationClass: "managed-default",
        sourcePath: "Templates/OMS/note.md",
        targetFolder: "Inbox",
        keyOrder: ["template", "status"],
        fields: {
          template: { type: "string" },
          status: { type: "select", allowedValues: ["open", "closed"] },
        },
        frontmatterTemplate: {},
        body: "",
        naming: "{{slug}}.md",
        views: [{ name: "status", keys: ["status"] }],
        inputSignature: signature,
        templateSignature: signature,
        managedSourcePaths: ["Templates/OMS/note.md"],
      },
    },
  };
}

async function snapshot(root: string, directory = root): Promise<readonly [string, string][]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: [string, string][] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) result.push([path.slice(root.length + 1), `symlink:${await readFile(path, "utf8")}`]);
    else if (entry.isDirectory()) result.push(...await snapshot(root, path));
    else result.push([path.slice(root.length + 1), await readFile(path, "utf8")]);
  }
  return result;
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-index-"));
  roots.push(root);
  await mkdir(join(root, "Templates", "OMS"), { recursive: true });
  await mkdir(join(root, "notes"), { recursive: true });
  await mkdir(join(root, ".oms"), { recursive: true });
  await Promise.all([
    writeFile(join(root, ".oms", "template-policy.json"), JSON.stringify({
      templates: { note: { sourcePath: "Templates/OMS/note.md" } },
    })),
    writeFile(join(root, "Templates", "OMS", "note.md"), "---\ntemplate: note\n---\nmanaged needle\n"),
    writeFile(join(root, "notes", "one.md"), "---\ntemplate: note\nstatus: open\n---\nneedle\n"),
    writeFile(join(root, "notes", "closed.md"), "---\ntemplate: note\nstatus: closed\n---\nclosed text\n"),
    writeFile(join(root, "notes", "missing.md"), "---\nconcept: note\nstatus: open\n---\nneedle\n"),
  ]);
  return root;
}

async function expectReadOnly<T>(root: string, query: () => T | Promise<T>): Promise<T> {
  const before = await snapshot(root);
  const result = await query();
  expect(await snapshot(root)).toEqual(before);
  return result;
}

describe("template note index", () => {
  it("builds a distinct versioned index bound to the projection signature", async () => {
    const index = await buildTemplateNoteIndex(await fixture(), convention());
    expect(index).toMatchObject({ version: TEMPLATE_NOTE_INDEX_VERSION, projectionSignature: signature });
  });

  it("resolves identity only from the stable template frontmatter key", async () => {
    const index = await buildTemplateNoteIndex(await fixture(), convention());
    expect(index.notes.map(note => note.path)).toEqual(["notes/closed.md", "notes/one.md"]);
  });

  it("never falls back from a missing template key to concept", async () => {
    const index = await buildTemplateNoteIndex(await fixture(), convention());
    expect(index.notes.some(note => note.path === "notes/missing.md")).toBe(false);
    expect(index.unresolvedNotes).toContainEqual({ path: "notes/missing.md", reason: "missing" });
  });

  it("indexes a BOM-prefixed CRLF managed note", async () => {
    const root = await fixture();
    await writeFile(join(root, "notes", "bom.md"), "\ufeff---\r\ntemplate: note\r\nstatus: open\r\n---\r\nbody\r\n");
    const index = await buildTemplateNoteIndex(root, convention());
    expect(index.notes).toContainEqual(expect.objectContaining({ path: "notes/bom.md", templateId: "note" }));
  });

  it("excludes managed template sources from the indexed note universe", async () => {
    const index = await buildTemplateNoteIndex(await fixture(), convention());
    expect(index.notes.some(note => note.path.startsWith("Templates/"))).toBe(false);
  });

  it("filters through the declared template identity axis without writing", async () => {
    const root = await fixture();
    const index = await buildTemplateNoteIndex(root, convention());
    const matches = await expectReadOnly(root, () => queryTemplateAxis(index, signature, { templateId: "note", key: "template", value: "note" }));
    expect(matches.map(note => note.path)).toEqual(["notes/closed.md", "notes/one.md"]);
  });

  it("filters through a declared field axis without writing", async () => {
    const root = await fixture();
    const index = await buildTemplateNoteIndex(root, convention());
    const matches = await expectReadOnly(root, () => queryTemplateAxis(index, signature, { templateId: "note", key: "status", value: "open" }));
    expect(matches.map(note => note.path)).toEqual(["notes/one.md"]);
  });

  it("rejects an undeclared typed axis instead of searching arbitrary frontmatter", async () => {
    const root = await fixture();
    const index = await buildTemplateNoteIndex(root, convention());
    await expectReadOnly(root, () => expect(() => queryTemplateAxis(index, signature, { templateId: "note", key: "unknown", value: "x" })).toThrow(/TEMPLATE_AXIS_UNDECLARED_FIELD.*note:unknown/));
  });

  it("rejects a stale projection signature without writing", async () => {
    const root = await fixture();
    const index = await buildTemplateNoteIndex(root, convention());
    await expectReadOnly(root, () => expect(() => queryTemplateAxis(index, staleSignature, { templateId: "note", key: "status", value: "open" })).toThrow(/TEMPLATE_NOTE_INDEX_STALE/));
  });

  it("rejects an unknown cache version instead of decoding it", async () => {
    const root = await fixture();
    const index = await buildTemplateNoteIndex(root, convention());
    await expectReadOnly(root, () => expect(() => queryTemplateAxis({ ...index, version: "old" }, signature, { templateId: "note", key: "status", value: "open" })).toThrow(/TEMPLATE_NOTE_INDEX_STALE/));
  });

  it("rejects a structurally incomplete current-version cache", async () => {
    const root = await fixture();
    const index = await buildTemplateNoteIndex(root, convention());
    const { axes: _axes, ...incomplete } = index;
    await expectReadOnly(root, () => expect(() => queryTemplateAxis(incomplete, signature, { templateId: "note", key: "status", value: "open" })).toThrow(/TEMPLATE_NOTE_INDEX_STALE/));
  });

  it("performs lexical retrieval without a projection or cache and never writes", async () => {
    const root = await fixture();
    const matches = await expectReadOnly(root, () => queryTemplateLexically(root, "needle"));
    expect(matches.map(note => note.path)).toEqual(["notes/missing.md", "notes/one.md"]);
  });

  it("returns an empty lexical result for an empty query without writing", async () => {
    const root = await fixture();
    expect(await expectReadOnly(root, () => queryTemplateLexically(root, ""))).toEqual([]);
  });

  it("rejects symlinked note sources rather than escaping the vault", async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "oms-template-index-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "outside.md"), "---\ntemplate: note\n---\noutside\n");
    await symlink(join(outside, "outside.md"), join(root, "notes", "linked.md"));
    await expect(buildTemplateNoteIndex(root, convention())).rejects.toThrow(/TEMPLATE_NOTE_SOURCE_UNSAFE.*symlink/);
  });
});
