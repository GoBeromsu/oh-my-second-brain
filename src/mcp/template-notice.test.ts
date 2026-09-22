import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { digestBytes } from "../kernel/templates/canonical.js";
import { parseTemplatePolicy, serializeDerivedProjection } from "../kernel/templates/policy.js";
import { controlGenerationDigest, expectedProjectionManaged, taxonomyRouting } from "../kernel/templates/resolver.js";
import {
  TEMPLATE_CHANGE_NOTICE_ACTIONS,
  TEMPLATE_CHANGE_NOTICE_MESSAGE,
  attachTemplateNotice,
  readTemplateChangeNotice,
  resetTemplateNoticeDeliveryForTests,
  templateNoticeForTool,
  templateNoticeInstruction,
} from "./template-notice.js";

const roots: string[] = [];
const encoder = new TextEncoder();
const RAW_SOURCE = "<%* raw template %>\n";
const TEMPLATE_MARKDOWN = "---\ntemplate: note\n---\n\n## Summary\n";

afterEach(async () => {
  resetTemplateNoticeDeliveryForTests();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

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

/** An approved v4 vault whose raw source is intact unless a test drifts it. */
async function fixture(drifted = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-notice-"));
  roots.push(root);
  await mkdir(join(root, ".oms", "templates"), { recursive: true });
  await mkdir(join(root, ".obsidian"), { recursive: true });
  await mkdir(join(root, "Sources"), { recursive: true });
  const policy = JSON.stringify({
    version: 4,
    properties: {},
    default: layer(".oms/templates/default.md", ""),
    templates: {
      note: layer(".oms/templates/note.md", TEMPLATE_MARKDOWN, {
        templateId: "note",
        source: { path: "Sources/note.md", identity: "note-source", rawDigest: digestBytes(RAW_SOURCE) },
      }),
    },
  });
  const taxonomy = JSON.stringify({ templates: { note: { templateFolder: "notes" } }, folders: {} });
  const generationDigest = controlGenerationDigest(encoder.encode(policy), encoder.encode(taxonomy));
  await writeFile(join(root, ".oms", "template-policy.json"), policy);
  await writeFile(join(root, ".oms", "taxonomy.json"), taxonomy);
  await writeFile(join(root, ".oms", "types.json"), serializeDerivedProjection({
    version: "oms.types.v2",
    generatedFrom: generationDigest,
    managed: expectedProjectionManaged(parseTemplatePolicy(policy), taxonomyRouting(".oms/taxonomy.json", encoder.encode(taxonomy)), generationDigest),
  }));
  await writeFile(join(root, ".oms", "templates", "default.md"), "");
  await writeFile(join(root, ".oms", "templates", "note.md"), TEMPLATE_MARKDOWN);
  await writeFile(join(root, ".obsidian", "types.json"), JSON.stringify({ types: { title: "text" } }));
  await writeFile(join(root, "Sources", "note.md"), drifted ? "<%* edited raw template %>\n" : RAW_SOURCE);
  return root;
}

describe("template notice", () => {
  it("offers review for a drifted raw source without naming it", async () => {
    const root = await fixture();
    const notice = await readTemplateChangeNotice(root);
    expect(notice).toMatchObject({
      state: "pending",
      pendingDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      pendingCount: 1,
      actions: TEMPLATE_CHANGE_NOTICE_ACTIONS,
      next: { tool: "oms_write", arguments: { op: "template", mode: "interview-next" } },
    });
    expect(templateNoticeInstruction(notice!)).toBe(TEMPLATE_CHANGE_NOTICE_MESSAGE);
    expect(templateNoticeInstruction(notice!)).not.toContain("note");
    expect(templateNoticeInstruction(notice!)).not.toContain("Sources");
  });

  it("omits a notice when nothing drifted from the approved contract", async () => {
    const root = await fixture(false);
    expect(await readTemplateChangeNotice(root)).toBeNull();
  });

  it("counts one pending entry per affected source", async () => {
    const root = await fixture();
    await writeFile(join(root, ".oms", "templates", "note.md"), "---\ntemplate: note\n---\n\nEdited draft.\n");
    const notice = await readTemplateChangeNotice(root);
    // One drifted raw source and one drifted managed draft, counted separately.
    expect(notice?.pendingCount).toBe(2);
  });

  it("deduplicates one digest across delivery and resurfaces a changed one", async () => {
    const root = await fixture();
    const first = await templateNoticeForTool(root, "dedupe");
    expect(first).not.toBeNull();
    expect(await templateNoticeForTool(root, "dedupe")).toBeNull();

    await writeFile(join(root, ".oms", "templates", "note.md"), "---\ntemplate: note\n---\n\nEdited draft.\n");
    const changed = await templateNoticeForTool(root, "dedupe");
    expect(changed).not.toBeNull();
    expect(changed?.pendingDigest).not.toBe(first?.pendingDigest);
  });

  it("does not deduplicate identical content from separate vaults", async () => {
    const firstRoot = await fixture();
    const secondRoot = await fixture();
    const first = await templateNoticeForTool(firstRoot, "dedupe");
    const second = await templateNoticeForTool(secondRoot, "dedupe");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second?.pendingDigest).not.toBe(first?.pendingDigest);
  });

  it("returns the full notice on every status poll", async () => {
    const root = await fixture();
    const first = await templateNoticeForTool(root, "poll");
    const second = await templateNoticeForTool(root, "poll");
    expect(first).not.toBeNull();
    expect(second).toEqual(first);
  });

  it("merges a notice into both JSON text and structured primary carriers", async () => {
    const root = await fixture();
    const result = await attachTemplateNotice(
      {
        content: [{ type: "text", text: JSON.stringify({ primary: "payload" }) }],
        structuredContent: { primary: "payload" },
      },
      root,
      "poll",
    );

    const text = result.content[0];
    expect(text?.type).toBe("text");
    expect(text?.type === "text" ? JSON.parse(text.text) : null).toMatchObject({
      primary: "payload",
      templateNotice: expect.any(Object),
    });
    expect(result.structuredContent).toMatchObject({
      primary: "payload",
      templateNotice: expect.any(Object),
    });
  });

  it("preserves non-JSON primary text and adds a compact notice block without a carrier", async () => {
    const root = await fixture();
    const result = await attachTemplateNotice(
      {
        isError: true,
        content: [{ type: "text", text: "primary failure" }],
      },
      root,
      "poll",
    );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "primary failure" },
      { type: "text", text: TEMPLATE_CHANGE_NOTICE_MESSAGE },
    ]);
    expect(result.structuredContent).toBeUndefined();
  });

  it("merges non-JSON notices into an existing carrier and preserves images", async () => {
    const root = await fixture();
    const textResult = await attachTemplateNotice(
      {
        content: [{ type: "text", text: "primary failure" }],
        structuredContent: { primary: "payload" },
      },
      root,
      "poll",
    );
    expect(textResult.content).toEqual([{ type: "text", text: "primary failure" }]);
    expect(textResult.structuredContent).toMatchObject({
      primary: "payload",
      templateNotice: expect.any(Object),
    });

    const imageResult = await attachTemplateNotice(
      {
        content: [{ type: "image", data: "encoded", mimeType: "image/png" }],
      },
      root,
      "poll",
    );
    expect(imageResult.content).toEqual([
      { type: "image", data: "encoded", mimeType: "image/png" },
      { type: "text", text: TEMPLATE_CHANGE_NOTICE_MESSAGE },
    ]);
    expect(imageResult.structuredContent).toBeUndefined();
  });

  it("fails open without stdout or a primary tool error", async () => {
    const root = await fixture();
    const runtimeRoot = await mkdtemp(join(tmpdir(), "oms-template-notice-runtime-"));
    roots.push(runtimeRoot);
    const previousRuntimeRoot = process.env["OMS_RUNTIME_ROOT"];
    process.env["OMS_RUNTIME_ROOT"] = runtimeRoot;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await rm(join(root, ".oms", "template-policy.json"));
      expect(await readTemplateChangeNotice(root)).toBeNull();
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      if (previousRuntimeRoot === undefined) delete process.env["OMS_RUNTIME_ROOT"];
      else process.env["OMS_RUNTIME_ROOT"] = previousRuntimeRoot;
    }
  });

  it("does not create an index while scanning", async () => {
    const root = await fixture();
    const before = await readdir(join(root, ".oms"));
    await readTemplateChangeNotice(root);
    expect(await readdir(join(root, ".oms"))).toEqual(before);
  });
});
