import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { digestBytes } from "./canonical.js";
import { buildTemplateInterview } from "./interview.js";
import { parseTemplatePolicy, serializeDerivedProjection } from "./policy.js";
import { controlGenerationDigest, expectedProjectionManaged, taxonomyRouting } from "./resolver.js";
import { MAX_TEMPLATE_SOURCE_BYTES, templateCensus } from "./census.js";

const encoder = new TextEncoder();
const roots: string[] = [];

function layer(templatePath: string, markdown: string, extra: Record<string, unknown> = {}) {
  return {
    templatePath,
    approvedMarkdown: markdown,
    approvedMarkdownDigest: digestBytes(markdown),
    fields: {},
    headings: [],
    semanticCriteria: [],
    ...extra,
  };
}

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-census-"));
  roots.push(root);
  return root;
}

async function put(root: string, path: string, content: string | Uint8Array): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function installApproved(sourceDigest: Uint8Array, files: Readonly<Record<string, string | Uint8Array>> = {}): Promise<string> {
  const root = await vault();
  const policy = {
    version: 4,
    properties: {},
    default: layer(".oms/templates/default.md", ""),
    templates: {
      literature: layer(".oms/templates/literature.md", "", {
        templateId: "literature",
        source: {
          path: "Sources/literature.md",
          identity: "literature-source",
          rawDigest: digestBytes(sourceDigest),
        },
      }),
    },
  };
  const policyText = JSON.stringify(policy);
  const taxonomyText = "{}";
  const policyBytes = encoder.encode(policyText);
  const taxonomyBytes = encoder.encode(taxonomyText);
  const generation = controlGenerationDigest(policyBytes, taxonomyBytes);
  const projection = serializeDerivedProjection({
    version: "oms.types.v2",
    generatedFrom: generation,
    managed: expectedProjectionManaged(parseTemplatePolicy(policyText), taxonomyRouting(".oms/taxonomy.json", taxonomyBytes), generation),
  });
  await put(root, ".oms/template-policy.json", policyText);
  await put(root, ".oms/taxonomy.json", taxonomyText);
  await put(root, ".oms/types.json", projection);
  await put(root, ".oms/templates/default.md", "");
  await put(root, ".oms/templates/literature.md", "");
  for (const [path, content] of Object.entries(files)) await put(root, path, content);
  return root;
}

async function signature(root: string): Promise<string> {
  const rows: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const name = relative(root, full).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) rows.push(`link ${name}`);
      else if (entry.isDirectory()) {
        rows.push(`dir ${name}`);
        await walk(full);
      } else if (entry.isFile()) rows.push(`file ${name} ${digestBytes(new Uint8Array(await readFile(full)))}`);
      else rows.push(`other ${name}`);
    }
  }
  await walk(root);
  return rows.join("\n");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("raw template census", () => {
  it("preserves raw Templater text, a BOM, and CRLF without parsing or executing it", async () => {
    const root = await vault();
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("line\r\n<% tp.file.title %>\r\n${Date.now()}\r\n", "utf8"),
    ]);
    await put(root, "Templates/raw.md", bytes);
    const census = await templateCensus(root, {
      includeConfiguredPaths: false,
      selections: [{ path: "Templates", kind: "folder" }],
    });
    expect(census.authority).toBe("absent");
    expect(census.sources).toHaveLength(1);
    expect(census.sources[0]?.text).toBe("\uFEFFline\r\n<% tp.file.title %>\r\n${Date.now()}\r\n");
    expect(census.sources[0]?.rawDigest).toBe(digestBytes(bytes));
    expect(census.sources[0]?.text).toContain("<% tp.file.title %>");
    expect(census.bindings).toEqual([]);
  });

  it("treats a missing policy as absent authority and an unreadable policy as invalid", async () => {
    const absent = await vault();
    await put(absent, ".oms/taxonomy.json", "{}");
    const absentCensus = await templateCensus(absent, { includeConfiguredPaths: false });
    expect(absentCensus.authority).toBe("absent");
    expect(absentCensus.approvedPolicy).toBeNull();
    expect(absentCensus.generationDigest).toBeNull();
    expect(absentCensus.diagnostics.some(item => item.code === "CONTRACT_UNVERIFIABLE")).toBe(false);

    const invalid = await vault();
    await put(invalid, ".oms/template-policy.json", "{");
    const invalidCensus = await templateCensus(invalid, { includeConfiguredPaths: false });
    expect(invalidCensus.authority).toBe("invalid");
    expect(invalidCensus.approvedPolicy).toBeNull();
    expect(invalidCensus.diagnostics.some(item => item.code === "CONTRACT_UNVERIFIABLE")).toBe(true);
    expect(invalidCensus.censusDigest).not.toBe(absentCensus.censusDigest);

    const legacy = await vault();
    await put(legacy, ".oms/template-policy.json", JSON.stringify({ version: 3, templates: {} }));
    const legacyCensus = await templateCensus(legacy, { includeConfiguredPaths: false });
    expect(legacyCensus.authority).toBe("invalid");
    expect(legacyCensus.diagnostics.some(item => item.code === "TEMPLATE_POLICY_VERSION_UNSUPPORTED")).toBe(true);

    const half = await vault();
    await put(half, ".oms/template-policy.json", JSON.stringify({
      version: 4,
      properties: {},
      default: layer(".oms/templates/default.md", ""),
      templates: {},
    }));
    const halfCensus = await templateCensus(half, { includeConfiguredPaths: false });
    expect(halfCensus.authority).toBe("invalid");
    expect(halfCensus.approvedPolicy).toBeNull();
  });

  it("reports non-UTF8 and oversize sources without dropping the raw digest of readable bytes", async () => {
    const root = await vault();
    const malformed = Buffer.from([0xff, 0xfe, 0x00]);
    await put(root, "Templates/bad.md", malformed);
    await put(root, "Templates/huge.md", Buffer.alloc(MAX_TEMPLATE_SOURCE_BYTES + 1, 0x61));
    const census = await templateCensus(root, {
      includeConfiguredPaths: false,
      selections: [{ path: "Templates", kind: "folder" }],
    });
    const bad = census.sources.find(source => source.path === "Templates/bad.md");
    expect(bad?.text).toBeNull();
    expect(bad?.rawDigest).toBe(digestBytes(malformed));
    expect(census.sources.some(source => source.path === "Templates/huge.md")).toBe(false);
    expect(census.diagnostics.some(item => item.code === "TEMPLATE_SOURCE_MALFORMED" && item.path === "Templates/bad.md")).toBe(true);
    expect(census.diagnostics.some(item => item.code === "TEMPLATE_PROPOSAL_OVERSIZE" && item.path === "Templates/huge.md")).toBe(true);
  });

  it("keeps configured file and folder selections raw and refuses symlink or private paths", async () => {
    const configured = await vault();
    await put(configured, "Notes/plain.md", "This ordinary note has an unmanaged property.\n");
    await put(configured, "Templates/a.md", "<% tp.date.now() %>\n");
    await put(configured, "Templates/b.txt", "not a template\n");
    await put(configured, ".obsidian/templates.json", JSON.stringify({ folder: "Templates" }));
    const folderCensus = await templateCensus(configured, { selections: [] });
    expect(folderCensus.sources.map(source => source.path)).toEqual(["Templates/a.md"]);

    const filesOnly = await vault();
    await put(filesOnly, "Templates/only.md", "<% tp.file.cursor() %>\n");
    await put(filesOnly, "Templates/sibling.md", "sibling\n");
    await put(filesOnly, ".obsidian/plugins/templater-obsidian/data.json", JSON.stringify({
      file_templates: [{ template: "Templates/only.md" }],
    }));
    const fileCensus = await templateCensus(filesOnly, { selections: [] });
    expect(fileCensus.sources.map(source => source.path)).toEqual(["Templates/only.md"]);

    const guarded = await vault();
    await put(guarded, "Templates/real.md", "real\n");
    const outside = join(tmpdir(), "oms-census-outside.md");
    await writeFile(outside, "OUTSIDE-SENTINEL\n");
    try {
      await symlink(join(guarded, "Templates", "real.md"), join(guarded, "Templates", "link.md"));
      await symlink(outside, join(guarded, "Templates", "outside.md"));
      const census = await templateCensus(guarded, {
        includeConfiguredPaths: false,
        selections: [
          { path: "Templates", kind: "folder" },
          { path: ".oms/secret.md", kind: "file" },
          { path: "../secret.md", kind: "file" },
        ],
      });
      expect(census.sources.map(source => source.path)).toEqual(["Templates/real.md"]);
      expect(JSON.stringify(census.sources)).not.toContain("OUTSIDE-SENTINEL");
      expect(census.diagnostics.some(item => item.code === "TEMPLATE_SOURCE_UNSAFE" && item.path === "Templates/link.md")).toBe(true);
      expect(census.diagnostics.some(item => item.code === "TEMPLATE_SOURCE_UNSAFE" && item.path === "Templates/outside.md")).toBe(true);
      expect(census.diagnostics.some(item => item.code === "TEMPLATE_SOURCE_UNSAFE" && item.path === ".oms/secret.md")).toBe(true);
      expect(census.diagnostics.some(item => item.code === "TEMPLATE_SOURCE_UNSAFE" && item.path === "../secret.md")).toBe(true);
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("pairs only a unique exact-byte move and keeps drift, ambiguity, and body-only adds unbound", async () => {
    const same = encoder.encode("---\nid: 1\n---\r\nBody\n");
    const bodyOnly = encoder.encode("Body\n");
    const drifted = await installApproved(same, { "Sources/literature.md": encoder.encode("changed\n") });
    const drift = await templateCensus(drifted, { includeConfiguredPaths: false });
    expect(drift.authority).toBe("approved");
    expect(drift.bindings).toEqual([expect.objectContaining({
      templateId: "literature",
      status: "drift",
      observedPath: "Sources/literature.md",
    })]);
    expect(drift.diffs).toEqual([expect.objectContaining({ kind: "edited", templateId: "literature", automatic: false })]);
    expect(drift.diagnostics.some(item => item.code === "SOURCE_DRIFT")).toBe(true);

    const moved = await installApproved(same, { "Sources/moved.md": same, "Sources/reading-note.md": bodyOnly });
    const relocate = await templateCensus(moved, {
      includeConfiguredPaths: false,
      selections: [{ path: "Sources", kind: "folder" }],
    });
    expect(relocate.bindings).toEqual([expect.objectContaining({
      templateId: "literature",
      status: "relocated",
      approvedPath: "Sources/literature.md",
      observedPath: "Sources/moved.md",
    })]);
    expect(relocate.diffs.find(diff => diff.kind === "relocated")).toMatchObject({ automatic: true, templateId: "literature" });
    expect(relocate.diffs.find(diff => diff.path === "Sources/reading-note.md")).toMatchObject({
      kind: "added",
      templateId: null,
      automatic: false,
    });
    expect(relocate.bindings.every(binding => binding.templateId === "literature")).toBe(true);

    const ambiguous = await installApproved(same, { "Sources/a.md": same, "Sources/b.md": same });
    const ambiguousCensus = await templateCensus(ambiguous, {
      includeConfiguredPaths: false,
      selections: [{ path: "Sources", kind: "folder" }],
    });
    expect(ambiguousCensus.bindings[0]).toMatchObject({
      templateId: "literature",
      status: "ambiguous",
      observedPath: null,
      candidatePaths: ["Sources/a.md", "Sources/b.md"],
    });
    expect(ambiguousCensus.diffs.some(diff => diff.automatic)).toBe(false);
    expect(ambiguousCensus.diffs.some(diff => diff.kind === "added")).toBe(false);
    expect(ambiguousCensus.diagnostics.some(item => item.code === "TEMPLATE_RENAME_AMBIGUOUS")).toBe(true);

    const guessed = await installApproved(same, { "Sources/body-only.md": bodyOnly });
    const guess = await templateCensus(guessed, {
      includeConfiguredPaths: false,
      selections: [{ path: "Sources", kind: "folder" }],
    });
    expect(guess.bindings[0]).toMatchObject({ templateId: "literature", status: "missing", observedPath: null });
    expect(guess.diffs.find(diff => diff.path === "Sources/body-only.md")).toMatchObject({ kind: "added", templateId: null, automatic: false });
    expect(guess.diffs.some(diff => diff.kind === "relocated")).toBe(false);
  });

  it("does not write ordinary notes or template controls", async () => {
    const root = await vault();
    await put(root, "Notes/plain.md", "unmanaged property status is missing\n");
    const before = await signature(root);
    const census = await templateCensus(root, {
      includeConfiguredPaths: false,
      selections: [{ path: "Notes", kind: "folder" }],
    });
    buildTemplateInterview(census);
    expect(await signature(root)).toBe(before);
    expect(census.diffs.find(diff => diff.path === "Notes/plain.md")?.templateId).toBeNull();
  });
});
