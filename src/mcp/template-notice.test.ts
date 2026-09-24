import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { digestBytes } from "../kernel/templates/canonical.js";
import { serializeContractPolicyV5 } from "../kernel/templates/contract-v5.js";
import { serializeVaultSettings } from "../kernel/templates/vault-settings.js";
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

async function fixture(drifted = true, held = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-notice-"));
  roots.push(root);
  await mkdir(join(root, ".oms"), { recursive: true });
  await mkdir(join(root, ".obsidian"), { recursive: true });
  await mkdir(join(root, "Sources"), { recursive: true });
  await writeFile(join(root, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: "11111111-1111-4111-8111-111111111111", templateRoots: ["Sources"] }));
  await writeFile(join(root, ".oms", "template-policy.json"), serializeContractPolicyV5({
    version: 5,
    revision: 1,
    properties: { title: { type: "text", intent: "Note title." } },
    common: { status: "active", fields: {} },
    templates: {
      note: {
        status: "active",
        source: { identity: "note-source", path: "Sources/note.md", rawDigest: digestBytes(RAW_SOURCE) },
        fields: { title: { required: true } },
      },
      ...(held ? { legacy: { status: "review-required" as const, reasons: ["historical semantic rule"], legacy: { note: "kept" } } } : {}),
    },
  }));
  await writeFile(join(root, ".oms", "taxonomy.json"), JSON.stringify({ templates: { note: { templateFolder: "notes" } }, folders: {} }));
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
      next: { skill: "interview", mode: "review-sources" },
    });
    expect(templateNoticeInstruction(notice!)).toBe(TEMPLATE_CHANGE_NOTICE_MESSAGE);
    expect(templateNoticeInstruction(notice!)).not.toContain("note");
    expect(templateNoticeInstruction(notice!)).not.toContain("Sources");
  });

  it("omits a notice when nothing drifted from the approved contract", async () => {
    const root = await fixture(false);
    expect(await readTemplateChangeNotice(root)).toBeNull();
  });

  it("counts one pending entry per affected registration", async () => {
    const root = await fixture(true, true);
    const notice = await readTemplateChangeNotice(root);
    // One drifted source and one held registration, counted separately.
    expect(notice?.pendingCount).toBe(2);
  });

  it("deduplicates one digest across delivery and resurfaces a changed pending set", async () => {
    const root = await fixture();
    const first = await templateNoticeForTool(root, "dedupe");
    expect(first).not.toBeNull();
    // Another edit to the same already-pending source is the same pending set,
    // so the user is not notified twice for one unreviewed registration.
    await writeFile(join(root, "Sources", "note.md"), "<%* edited again %>\n");
    expect(await templateNoticeForTool(root, "dedupe")).toBeNull();

    // A second affected registration is a genuinely new pending set.
    await writeFile(join(root, ".oms", "template-policy.json"), await readFile(join(await fixture(true, true), ".oms", "template-policy.json"), "utf8"));
    const changed = await templateNoticeForTool(root, "dedupe");
    expect(changed).not.toBeNull();
    expect(changed?.pendingDigest).not.toBe(first?.pendingDigest);
    expect(changed?.pendingCount).toBe(2);
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
