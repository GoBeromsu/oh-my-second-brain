import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveTemplateRetrievalAxes } from "./axes.js";
import type { TemplateRetrievalSource } from "./axes.js";
import { digestBytes } from "./canonical.js";
import {
  buildTemplateNoteIndex,
  queryTemplateAxis,
  queryTemplateLexically,
  TEMPLATE_NOTE_INDEX_VERSION,
} from "./note-index.js";
import type { TemplateIndexedNote, TemplateNoteIndex } from "./note-index.js";
import type { RetrievalFields } from "./axes.js";
import type { EffectiveFieldV5 } from "./contract-v5.js";
import type { Digest } from "./types.js";

const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Digest;
const STALE = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Digest;
const roots: string[] = [];

const FILES = {
  "Templates/OMS/note.md": "---\ntemplate: note\ntitle: Source\nstatus: open\n---\nneedle\n",
  "Templates/OMS/loose.md": "---\ntemplate: note\ntitle: Loose\nstatus: open\n---\nloose\n",
  ".oms/templates/default.md": "---\ntemplate: note\ntitle: Draft\nstatus: open\n---\nneedle\n",
  "notes/.secret.md": "---\ntemplate: note\ntitle: Secret\nstatus: open\n---\nneedle\n",
  "notes/bound-open.md": "---\ntemplate: note\ntitle: Yes\nstatus: open\n---\nneedle\n",
  "notes/bound-bad.md": "---\ntemplate: note\ntitle: Yes\nstatus: later\n---\nbad\n",
  "notes/bound-missing.md": "---\ntemplate: note\nstatus: open\n---\nmissing-title\n",
  "notes/broken.md": "---\ntemplate: note\nstatus: open\nraw-broken-token\n",
  "notes/empty.md": "plain\n",
  "notes/nan.md": "---\ntemplate: note\ntitle: Yes\nstatus: open\ncount: .nan\n---\nnan\n",
  "notes/numeric.md": "---\ntemplate: 1\nstatus: open\n---\nnumeric\n",
  "notes/proto.md": "---\ntemplate: note\ntitle: Yes\nstatus: open\nconstructor: kept\n__proto__:\n  admin: true\n---\nproto\n",
  "notes/skip.template.md": "---\ntemplate: note\ntitle: Skip\nstatus: open\n---\nneedle\n",
  "notes/tags.md": "---\ntemplate: note\ntitle: Yes\nstatus: open\ntags:\n  - b\n  - a\n---\ntags\n",
  "notes/task.md": "---\ntemplate: task\nstatus: open\n---\ntask\n",
  "notes/unbound-bad.md": "---\nstatus: later\n---\nlater\n",
  "notes/unbound.md": "---\nstatus: open\n---\nneedle\n",
  "notes/unknown.md": "---\ntemplate: ghost\nstatus: open\n---\nunknown\n",
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function mapping<T>(entries: readonly (readonly [string, T])[]): Record<string, T> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) record[key] = value;
  return record;
}

function field(property: string, overrides: Partial<EffectiveFieldV5> = {}): EffectiveFieldV5 {
  return { property, type: "string", required: false, valuePolicy: "free", ...overrides };
}

function fields(entries: readonly (readonly [string, EffectiveFieldV5])[]): RetrievalFields {
  const record = Object.create(null) as Record<string, EffectiveFieldV5>;
  for (const [key, value] of entries) record[key] = value;
  return record;
}

function retrieval(): TemplateRetrievalSource {
  return {
    generationDigest: DIGEST,
    defaultFields: fields([
      ["title", field("title", { intent: "Default title.", required: true })],
      ["status", field("status", { type: "select", intent: "Default status.", valuePolicy: "closed", allowedValues: ["open", "closed"] })],
    ]),
    templates: {
      note: fields([
        ["status", field("status", { type: "select", intent: "Workflow state.", valuePolicy: "closed", allowedValues: ["open", "closed"] })],
        ["title", field("title", { intent: "Title.", required: true, format: "url" })],
        ["constructor", field("constructor", { intent: "Prototype name." })],
        ["__proto__", field("__proto__", { intent: "Prototype key." })],
        ["tags", field("tags", { type: "list", intent: "Tags.", valuePolicy: "suggest", allowedValues: ["a"] })],
        ["count", field("count", { type: "number", intent: "Count." })],
      ]),
      task: fields([
        ["status", field("status", { type: "select", intent: "Task state.", valuePolicy: "closed", allowedValues: ["open", "closed"] })],
      ]),
    },
    globalAxes: {
      links: { kind: "link", key: "related", type: "list", members: ["parent", "child"] },
      folders: { kind: "folder", key: "folder", type: "select", intent: "Placement.", members: ["notes", "archive"] },
    },
    // Registered originals the index must not treat as ordinary notes.
    sourcePaths: ["Templates/OMS/note.md", "Sources/deleted.md"],
  };
}

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const full = join(root, relativePath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

async function fixture(): Promise<string> {
  const root = await tempDir("oms-template-index-");
  await writeTree(root, FILES);
  return root;
}

async function snapshot(root: string, directory = root): Promise<readonly [string, string][]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: [string, string][] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    const relativePath = path.slice(root.length + 1);
    if (entry.isSymbolicLink()) result.push([relativePath, "symlink"]);
    else if (entry.isDirectory()) result.push(...await snapshot(root, path));
    else result.push([relativePath, await readFile(path, "utf8")]);
  }
  return result;
}

async function expectReadOnly<T>(root: string, query: () => T | Promise<T>): Promise<T> {
  const before = await snapshot(root);
  try {
    return await query();
  } finally {
    expect(await snapshot(root)).toEqual(before);
  }
}

function noteAt(index: TemplateNoteIndex, path: string): TemplateIndexedNote {
  const found = index.notes.find(note => note.path === path);
  expect(found, path).toBeDefined();
  return found!;
}

describe("template note index", () => {
  it("includes invalid, unbound, unknown, and non-string notes without guessing an identity", async () => {
    const root = await fixture();
    const source = retrieval();
    const index = await expectReadOnly(root, () => buildTemplateNoteIndex(root, source));
    expect(index.version).toBe("oms.template-note-index.v4");
    expect(index.generationDigest).toBe(DIGEST);
    expect(index.generationDigest).not.toBe(digestBytes(FILES["notes/bound-open.md"]));
    expect(index.axes).toEqual(deriveTemplateRetrievalAxes(source));
    expect(index.axes.defaultAxes.map(axis => axis.key)).toEqual(["title", "status"]);
    expect(index.axes.templates.map(item => [item.templateId, item.axes.map(axis => axis.key)])).toEqual([
      ["note", ["template", "status", "title", "constructor", "__proto__", "tags", "count"]],
      ["task", ["template", "status"]],
    ]);
    expect(index.axes.templates[0]?.axes[0]).toEqual({ kind: "identity", key: "template", type: "string", templateId: "note" });
    expect(index.notes.map(note => [note.path, note.layer, note.templateId])).toEqual([
      ["Templates/OMS/loose.md", "template", "note"],
      ["notes/bound-bad.md", "template", "note"],
      ["notes/bound-missing.md", "template", "note"],
      ["notes/bound-open.md", "template", "note"],
      ["notes/broken.md", "unresolved", null],
      ["notes/empty.md", "default", null],
      ["notes/nan.md", "template", "note"],
      ["notes/numeric.md", "unresolved", null],
      ["notes/proto.md", "template", "note"],
      ["notes/skip.template.md", "template", "note"],
      ["notes/tags.md", "template", "note"],
      ["notes/task.md", "template", "task"],
      ["notes/unbound-bad.md", "default", null],
      ["notes/unbound.md", "default", null],
      ["notes/unknown.md", "unresolved", null],
    ]);
    expect(index.unresolvedNotes).toEqual([
      { path: "notes/broken.md", reason: "invalid-frontmatter" },
      { path: "notes/numeric.md", reason: "non-string" },
      { path: "notes/unknown.md", reason: "unknown" },
    ]);
    expect(Object.hasOwn(noteAt(index, "notes/unbound.md").fields, "template")).toBe(false);
    expect(noteAt(index, "notes/unknown.md").fields["template"]).toBe("ghost");
    expect(noteAt(index, "notes/numeric.md").fields["template"]).toBe(1);
    expect(noteAt(index, "notes/broken.md").fields).toEqual({});
    expect(Object.getPrototypeOf(noteAt(index, "notes/broken.md").fields)).toBe(null);
    expect(noteAt(index, "notes/bound-open.md").signature).toBe(digestBytes(FILES["notes/bound-open.md"]));
    expect(noteAt(index, "notes/broken.md").signature).toBe(digestBytes(FILES["notes/broken.md"]));
  });

  it("indexes raw field values without judging required fields or allowed values", async () => {
    const index = await buildTemplateNoteIndex(await fixture(), retrieval());
    expect(index.diagnostics).toEqual([
      { path: "notes/nan.md", reason: "non-json-field", field: "count" },
    ]);
    expect(noteAt(index, "notes/bound-bad.md").fields["status"]).toBe("later");
    expect(Object.hasOwn(noteAt(index, "notes/bound-missing.md").fields, "title")).toBe(false);
    expect(index.unresolvedNotes.some(note => note.path === "notes/empty.md")).toBe(false);
    const nan = noteAt(index, "notes/nan.md");
    expect(Object.hasOwn(nan.fields, "count")).toBe(false);
    expect(nan.fields["status"]).toBe("open");
    expect(nan.layer).toBe("template");
  });

  it("keeps notes with recursive YAML values without recursing indefinitely", async () => {
    const root = await fixture();
    await writeFile(join(root, "notes", "recursive.md"),
      "---\ntemplate: note\ncycle: &cycle [*cycle]\nvalues: &values [open]\nshared: {first: *values, second: *values}\n---\nsearchable body\n");
    const index = await buildTemplateNoteIndex(root, retrieval());
    const note = noteAt(index, "notes/recursive.md");
    expect(note.layer).toBe("template");
    expect(Object.hasOwn(note.fields, "cycle")).toBe(false);
    expect(note.fields["shared"]).toEqual({ first: ["open"], second: ["open"] });
    expect(index.diagnostics).toContainEqual({ path: "notes/recursive.md", reason: "non-json-field", field: "cycle" });
  });

  it("keeps prototype-named frontmatter fields on a dictionary without a prototype", async () => {
    const index = await buildTemplateNoteIndex(await fixture(), retrieval());
    const proto = noteAt(index, "notes/proto.md");
    expect(Object.getPrototypeOf(proto.fields)).toBe(null);
    expect(proto.fields["constructor"]).toBe("kept");
    expect(Object.hasOwn(proto.fields, "__proto__")).toBe(true);
    expect(proto.fields["__proto__"]).toEqual({ admin: true });
  });

  it("excludes approved snapshot sources and hidden drafts without reading disk policy", async () => {
    const root = await fixture();
    const index = await expectReadOnly(root, () => buildTemplateNoteIndex(root, retrieval()));
    const indexed = index.notes.map(note => note.path);
    expect(indexed).toContain("Templates/OMS/loose.md");
    expect(indexed).toContain("notes/skip.template.md");
    expect(indexed).not.toContain("Templates/OMS/note.md");
    expect(indexed).not.toContain(".oms/templates/default.md");
    expect(indexed).not.toContain("notes/.secret.md");
    expect(index.unresolvedNotes.map(note => note.path)).not.toContain("Templates/OMS/note.md");
    const matches = await expectReadOnly(root, () => queryTemplateLexically(root, "needle"));
    expect(matches).toEqual([
      { path: "Templates/OMS/note.md", signature: digestBytes(FILES["Templates/OMS/note.md"]) },
      { path: "notes/bound-open.md", signature: digestBytes(FILES["notes/bound-open.md"]) },
      { path: "notes/unbound.md", signature: digestBytes(FILES["notes/unbound.md"]) },
    ]);
    expect(await expectReadOnly(root, () => queryTemplateLexically(root, ""))).toEqual([]);
    expect(await expectReadOnly(root, () => queryTemplateLexically(root, "raw-broken-token"))).toEqual([
      { path: "notes/broken.md", signature: digestBytes(FILES["notes/broken.md"]) },
    ]);
  });

  it("queries default and individual axes, including values that violate the contract", async () => {
    const root = await fixture();
    const index = await buildTemplateNoteIndex(root, retrieval());
    await expectReadOnly(root, () => {
      expect(queryTemplateAxis(index, DIGEST, { templateId: null, key: "status", value: "open" }).map(note => note.path)).toEqual(["notes/unbound.md"]);
      expect(queryTemplateAxis(index, DIGEST, { templateId: null, key: "status", value: "later" }).map(note => note.path)).toEqual(["notes/unbound-bad.md"]);
      expect(queryTemplateAxis(index, DIGEST, { templateId: "note", key: "template", value: "note" }).map(note => note.path)).toEqual([
        "Templates/OMS/loose.md",
        "notes/bound-bad.md",
        "notes/bound-missing.md",
        "notes/bound-open.md",
        "notes/nan.md",
        "notes/proto.md",
        "notes/skip.template.md",
        "notes/tags.md",
      ]);
      expect(queryTemplateAxis(index, DIGEST, { templateId: "note", key: "template", value: "task" })).toEqual([]);
      expect(queryTemplateAxis(index, DIGEST, { templateId: "note", key: "status", value: "open" }).map(note => note.path)).toEqual([
        "Templates/OMS/loose.md",
        "notes/bound-missing.md",
        "notes/bound-open.md",
        "notes/nan.md",
        "notes/proto.md",
        "notes/skip.template.md",
        "notes/tags.md",
      ]);
      expect(queryTemplateAxis(index, DIGEST, { templateId: "note", key: "status", value: "later" }).map(note => note.path)).toEqual(["notes/bound-bad.md"]);
      expect(queryTemplateAxis(index, DIGEST, { templateId: "task", key: "status", value: "open" }).map(note => note.path)).toEqual(["notes/task.md"]);
      expect(queryTemplateAxis(index, DIGEST, { templateId: "note", key: "tags", value: ["b", "a"] }).map(note => note.path)).toEqual(["notes/tags.md"]);
      expect(queryTemplateAxis(index, DIGEST, { templateId: "note", key: "tags", value: ["a", "b"] })).toEqual([]);
      expect(queryTemplateAxis(index, DIGEST, { templateId: "note", key: "constructor", value: "kept" }).map(note => note.path)).toEqual(["notes/proto.md"]);
      expect(queryTemplateAxis(index, DIGEST, { templateId: "note", key: "__proto__", value: { admin: true } }).map(note => note.path)).toEqual(["notes/proto.md"]);
      expect(queryTemplateAxis(index, DIGEST, { templateId: null, key: "status", value: null })).toEqual([]);
    });
  });

  it("rejects undeclared axes and stale generations without writing", async () => {
    const root = await fixture();
    const index = await buildTemplateNoteIndex(root, retrieval());
    await expectReadOnly(root, () => {
      expect(() => queryTemplateAxis(index, DIGEST, { templateId: null, key: "template", value: "note" })).toThrow(/TEMPLATE_AXIS_UNDECLARED_FIELD: default:template/);
      expect(() => queryTemplateAxis(index, DIGEST, { templateId: null, key: "tags", value: ["b", "a"] })).toThrow(/TEMPLATE_AXIS_UNDECLARED_FIELD: default:tags/);
      expect(() => queryTemplateAxis(index, DIGEST, { templateId: "note", key: "missing", value: "x" })).toThrow(/TEMPLATE_AXIS_UNDECLARED_FIELD: note:missing/);
      expect(() => queryTemplateAxis(index, DIGEST, { templateId: "ghost", key: "status", value: "open" })).toThrow(/TEMPLATE_AXIS_UNDECLARED_FIELD: ghost:status/);
      expect(() => queryTemplateAxis(index, STALE, { templateId: "note", key: "status", value: "open" })).toThrow(/TEMPLATE_NOTE_INDEX_STALE/);
      expect(() => queryTemplateAxis({ ...index, version: "oms.template-note-index.v2" }, DIGEST, { templateId: "note", key: "status", value: "open" })).toThrow(/TEMPLATE_NOTE_INDEX_STALE/);
      const { notes: _notes, ...incomplete } = index;
      expect(() => queryTemplateAxis(incomplete, DIGEST, { templateId: "note", key: "status", value: "open" })).toThrow(/TEMPLATE_NOTE_INDEX_STALE/);
    });
  });

  it("still builds from the snapshot when on-disk taxonomy and policy cannot be read", async () => {
    const root = await tempDir("oms-template-index-");
    await writeTree(root, {
      ".oms/taxonomy.json": "broken: [\n",
      ".oms/template-policy.json": "{broken",
      "notes/unbound.md": "---\nstatus: open\n---\nneedle\n",
      "drafts/note.md": "---\nstatus: open\n---\nneedle\n",
    });
    const index = await expectReadOnly(root, () => buildTemplateNoteIndex(root, retrieval()));
    expect(index.notes.map(note => note.path)).toEqual(["drafts/note.md", "notes/unbound.md"]);
    await expectReadOnly(root, () => expect(queryTemplateLexically(root, "needle")).rejects.toThrow(/NOTE_EXCLUSION_RESOLUTION_FAILED.*taxonomy\.json/));
  });

  it("rejects a symlinked note or directory before reading outside the vault", async () => {
    const outside = await tempDir("oms-template-index-outside-");
    await writeFile(join(outside, "outside.md"), "outside-secret\n");
    const linkedFile = await tempDir("oms-template-index-");
    await writeTree(linkedFile, { "notes/one.md": "needle\n" });
    await symlink(join(outside, "outside.md"), join(linkedFile, "notes", "linked.md"));
    await expectReadOnly(linkedFile, () => expect(buildTemplateNoteIndex(linkedFile, retrieval())).rejects.toThrow(/TEMPLATE_SOURCE_UNSAFE: symlink ancestors and leaves are not allowed/));
    await expectReadOnly(linkedFile, () => expect(queryTemplateLexically(linkedFile, "outside-secret")).rejects.toThrow(/TEMPLATE_SOURCE_UNSAFE: symlink ancestors and leaves are not allowed/));
    expect(await readFile(join(outside, "outside.md"), "utf8")).toBe("outside-secret\n");

    const linkedDirectory = await tempDir("oms-template-index-");
    await writeTree(linkedDirectory, { "notes/one.md": "needle\n" });
    await symlink(outside, join(linkedDirectory, "notes", "linked-dir"));
    await expectReadOnly(linkedDirectory, () => expect(buildTemplateNoteIndex(linkedDirectory, retrieval())).rejects.toThrow(/TEMPLATE_SOURCE_UNSAFE: symlink notes\/linked-dir is not allowed/));
    await expectReadOnly(linkedDirectory, () => expect(queryTemplateLexically(linkedDirectory, "outside-secret")).rejects.toThrow(/TEMPLATE_SOURCE_UNSAFE: symlink notes\/linked-dir is not allowed/));
  });
});

describe("lexical template search", () => {
  it.each([
    ["absent", undefined],
    ["invalid", "{broken"],
    ["null", "null"],
    ["retired v3 sourcePath", JSON.stringify({ version: 3, templates: { old: { sourcePath: "Sources/raw.md" } } })],
    ["a template list", JSON.stringify({ version: 4, templates: [] })],
  ])("searches when policy is %s and does not invent source exclusions", async (_label, policyText) => {
    const root = await tempDir("oms-template-index-");
    const files: Record<string, string> = {
      "Sources/raw.md": "needle\n",
      "notes/one.md": "needle\n",
      "notes/skip.template.md": "needle\n",
    };
    if (policyText !== undefined) files[".oms/template-policy.json"] = policyText;
    await writeTree(root, files);
    const matches = await expectReadOnly(root, () => queryTemplateLexically(root, "needle"));
    expect(matches.map(match => match.path)).toEqual(["Sources/raw.md", "notes/one.md"]);
    expect(matches[0]?.signature).toBe(digestBytes("needle\n"));
  });

  it("does not block search when a declared raw source is missing, and still excludes a real v4 source", async () => {
    const root = await tempDir("oms-template-index-");
    await writeTree(root, {
      ".oms/template-policy.json": JSON.stringify({
        version: 4,
        templates: {
          kept: { source: { path: "Sources/raw.md" } },
          missing: { source: { path: "Sources/deleted.md" } },
        },
      }),
      "Sources/raw.md": "needle\n",
      "notes/one.md": "needle\n",
    });
    const matches = await expectReadOnly(root, () => queryTemplateLexically(root, "needle"));
    expect(matches.map(match => match.path)).toEqual(["notes/one.md"]);
  });

  it("keeps explicit taxonomy and Obsidian template exclusions when policy is invalid", async () => {
    const taxonomy = await tempDir("oms-template-index-");
    await writeTree(taxonomy, {
      ".oms/taxonomy.json": JSON.stringify({ exclude: ["drafts/**"] }),
      ".oms/template-policy.json": "{broken",
      "drafts/note.md": "needle\n",
      "notes/one.md": "needle\n",
    });
    const indexed = await buildTemplateNoteIndex(taxonomy, retrieval());
    expect(indexed.notes.map(note => note.path)).toEqual(["drafts/note.md", "notes/one.md"]);
    expect((await expectReadOnly(taxonomy, () => queryTemplateLexically(taxonomy, "needle"))).map(match => match.path)).toEqual(["notes/one.md"]);

    const obsidian = await tempDir("oms-template-index-");
    await writeTree(obsidian, {
      ".obsidian/templates.json": JSON.stringify({ folder: "Core" }),
      ".oms/template-policy.json": "{broken",
      "Core/page.md": "needle\n",
      "Sources/raw.md": "needle\n",
      "notes/one.md": "needle\n",
    });
    expect((await expectReadOnly(obsidian, () => queryTemplateLexically(obsidian, "needle"))).map(match => match.path)).toEqual([
      "Sources/raw.md",
      "notes/one.md",
    ]);
  });

  it("does not replace a helper or filesystem failure with an unfiltered search", async () => {
    const taxonomy = await tempDir("oms-template-index-");
    await writeTree(taxonomy, {
      ".oms/taxonomy.json": "broken: [\n",
      "notes/one.md": "needle\n",
    });
    expect(await queryTemplateLexically(taxonomy, "")).toEqual([]);
    await expectReadOnly(taxonomy, () => expect(queryTemplateLexically(taxonomy, "needle")).rejects.toThrow(/NOTE_EXCLUSION_RESOLUTION_FAILED.*taxonomy\.json/));

    const obsidian = await tempDir("oms-template-index-");
    await writeTree(obsidian, {
      ".obsidian/templates.json": "{broken",
      "notes/one.md": "needle\n",
    });
    await expectReadOnly(obsidian, () => expect(queryTemplateLexically(obsidian, "needle")).rejects.toThrow(/NOTE_EXCLUSION_RESOLUTION_FAILED.*templates\.json/));

    const root = await tempDir("oms-template-index-");
    expect(await queryTemplateLexically(join(root, "absent"), "")).toEqual([]);
    await expect(queryTemplateLexically(join(root, "absent"), "needle")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
