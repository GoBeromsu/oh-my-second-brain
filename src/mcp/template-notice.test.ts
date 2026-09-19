import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  TEMPLATE_CHANGE_NOTICE_ACTIONS,
  TEMPLATE_CHANGE_NOTICE_MESSAGE,
  attachTemplateNotice,
  readTemplateChangeNotice,
  resetTemplateNoticeDeliveryForTests,
  templateNoticeFromContext,
  templateNoticeForTool,
  templateNoticeInstruction,
} from "./template-notice.js";
import type { TemplateReviewContext } from "../kernel/templates/review-context.js";

const roots: string[] = [];

afterEach(async () => {
  resetTemplateNoticeDeliveryForTests();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(selected = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-notice-"));
  roots.push(root);
  await mkdir(join(root, ".oms"), { recursive: true });
  await mkdir(join(root, ".obsidian"), { recursive: true });
  if (selected) await mkdir(join(root, "Templates"), { recursive: true });
  await writeFile(
    join(root, ".oms", "template-policy.json"),
    JSON.stringify({
      version: 3,
      templateFolders: selected ? [{ path: "Templates", default: true }] : [],
      base: { fields: {} },
      contracts: {},
      templates: {},
    }),
  );
  await writeFile(join(root, ".oms", "taxonomy.json"), JSON.stringify({ folders: {} }));
  await writeFile(join(root, ".obsidian", "types.json"), JSON.stringify({ types: { title: "text" } }));
  if (selected) {
    await writeFile(join(root, "Templates", "new-note.md"), "---\ntitle: New\n---\nBody\n");
  }
  return root;
}

describe("template notice", () => {
  it("uses the generic first-line text and the two review actions", async () => {
    const root = await fixture();
    const notice = await readTemplateChangeNotice(root);

    expect(notice).toMatchObject({
      state: "pending",
      pendingDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      pendingCount: 1,
      actions: TEMPLATE_CHANGE_NOTICE_ACTIONS,
      next: {
        tool: "oms_write",
        arguments: { op: "template", mode: "interview-next" },
      },
    });
    expect(templateNoticeInstruction(notice)).toBe(TEMPLATE_CHANGE_NOTICE_MESSAGE);
    expect(templateNoticeInstruction(notice)).not.toContain("new-note");
  });

  it("omits notices for an unchanged census", async () => {
    const root = await fixture(false);
    expect(await readTemplateChangeNotice(root)).toBeNull();
  });

  it("deduplicates one digest across write/search delivery and resurfaces a changed digest", async () => {
    const root = await fixture();
    const first = await templateNoticeForTool(root, "dedupe");
    expect(first).not.toBeNull();
    expect(await templateNoticeForTool(root, "dedupe")).toBeNull();

    await writeFile(join(root, "Templates", "new-note.md"), "---\ntitle: Changed\n---\nBody\n");
    const changed = await templateNoticeForTool(root, "dedupe");
    expect(changed).not.toBeNull();
    expect(changed?.pendingDigest).not.toBe(first?.pendingDigest);
  });

  it("does not deduplicate identical content from separate canonical vaults", async () => {
    const firstRoot = await fixture();
    const secondRoot = await fixture();
    const first = await templateNoticeForTool(firstRoot, "dedupe");
    const second = await templateNoticeForTool(secondRoot, "dedupe");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second?.pendingDigest).not.toBe(first?.pendingDigest);
  });

  it("counts a source once when its diff and diagnostic use both identity forms", () => {
    const digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000" as `sha256:${string}`;
    const context = {
      vault: "/tmp/template-notice-vault",
      policy: {
        templates: {
          note: {
            templateId: "note",
            sourcePath: "Templates/note.md",
          },
        },
      },
      census: {
        entries: [{ sourcePath: "Templates/note.md", templateId: "note" }],
        diffs: [{
          kind: "edited",
          sourcePath: "Templates/note.md",
          templateId: "note",
          automatic: true,
          confirmationRequired: false,
        }],
        diagnostics: [{
          code: "TEMPLATE_SOURCE_INVALID",
          path: "Templates/note.md",
          templateId: "note",
          message: "invalid source",
        }],
      },
      censusDigest: digest,
      projectionUsable: true,
      obsidianTypes: {},
      freshTemplateIds: [],
    } as unknown as TemplateReviewContext;

    expect(templateNoticeFromContext(context)?.pendingCount).toBe(1);
  });

  it("surfaces stale body coverage without invalidating a fresh sibling", () => {
    const digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000" as `sha256:${string}`;
    const context = {
      vault: "/tmp/template-notice-stale-body",
      policy: {
        templates: {
          note: {
            templateId: "note",
            sourcePath: "Templates/note.md",
            renderer: "obsidian-core",
            content: { bodySignature: digest },
          },
          sibling: {
            templateId: "sibling",
            sourcePath: "Templates/sibling.md",
            renderer: "obsidian-core",
          },
        },
      },
      census: {
        entries: [
          {
            sourcePath: "Templates/note.md",
            templateId: "note",
            bytes: new TextEncoder().encode("---\ntitle: Note\n---\nChanged body\n"),
            signature: digest,
            diagnostics: [],
          },
          {
            sourcePath: "Templates/sibling.md",
            templateId: "sibling",
            bytes: new Uint8Array(),
            signature: digest,
            diagnostics: [],
          },
        ],
        diffs: [],
        diagnostics: [],
      },
      censusDigest: digest,
      projectionUsable: true,
      obsidianTypes: {},
      // The resolver omits the stale-body binding from fresh coverage while
      // retaining the unchanged sibling.
      freshTemplateIds: ["sibling"],
    } as unknown as TemplateReviewContext;

    expect(templateNoticeFromContext(context)?.pendingCount).toBe(1);
  });

  it("surfaces a policy binding omitted from projection coverage once", () => {
    const digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111" as `sha256:${string}`;
    const context = {
      vault: "/tmp/template-notice-omitted-coverage",
      policy: {
        templates: {
          missing: {
            templateId: "missing",
            sourcePath: "Templates/missing.md",
          },
          fresh: {
            templateId: "fresh",
            sourcePath: "Templates/fresh.md",
          },
        },
      },
      census: {
        entries: [
          { sourcePath: "Templates/missing.md", templateId: "missing", bytes: new Uint8Array(), signature: digest, diagnostics: [] },
          { sourcePath: "Templates/fresh.md", templateId: "fresh", bytes: new Uint8Array(), signature: digest, diagnostics: [] },
        ],
        diffs: [],
        diagnostics: [],
      },
      censusDigest: digest,
      projectionUsable: true,
      obsidianTypes: {},
      freshTemplateIds: ["fresh"],
    } as unknown as TemplateReviewContext;

    expect(templateNoticeFromContext(context)?.pendingCount).toBe(1);
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
