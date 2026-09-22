import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sharedAuthoritySignature, sourceSignature } from "./resolver.js";
import { repairPendingTemplateSource } from "./pending-source.js";
import type { Digest } from "./types.js";

const roots: string[] = [];
const sha = (value: string | Uint8Array): Digest => `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;
const original = "---\ntitle: Old\n---\nOld body\n";
const proposed = "---\ntitle: New\n---\n<!-- oms:content -->\n";
const unrelated = "---\ntitle: Unrelated\n---\nUnrelated body\n";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-pending-source-"));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, ".oms"), { recursive: true }),
    mkdir(join(root, ".obsidian"), { recursive: true }),
    mkdir(join(root, "Templates"), { recursive: true }),
  ]);
  const policy = JSON.stringify({
    version: 3,
    templateFolders: [{ path: "Templates", default: true }],
    base: { fields: {} },
    contracts: { base: { intent: "Base", fields: {}, views: [] } },
    templates: {},
  });
  const taxonomy = JSON.stringify({ folders: {} });
  const obsidian = JSON.stringify({ types: { title: "text" } });
  const descriptors = [
    { logicalId: "template-policy", signature: sha(policy) },
    { logicalId: "taxonomy", signature: sha(taxonomy) },
    { logicalId: "obsidian-types", signature: sha(obsidian) },
  ];
  const projection = JSON.stringify({
    version: "oms.types.v1",
    generatedFrom: {
      algorithm: "sha256-lp-v1",
      inputSignature: sourceSignature(descriptors),
      sharedAuthoritySignature: sharedAuthoritySignature(descriptors),
      sources: descriptors,
    },
    managed: { base: { fields: {} }, templates: {}, globalAxes: {} },
  });
  await Promise.all([
    writeFile(join(root, ".oms/template-policy.json"), policy),
    writeFile(join(root, ".oms/taxonomy.json"), taxonomy),
    writeFile(join(root, ".oms/types.json"), projection),
    writeFile(join(root, ".obsidian/types.json"), obsidian),
    writeFile(join(root, "Templates/agent-session.template.md"), original),
    writeFile(join(root, "Templates/unrelated.md"), unrelated),
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("pending template source repair", () => {
  it("plans and applies one exact-path replacement while preserving controls and unrelated sources", async () => {
    const root = await fixture();
    const controls = [".oms/template-policy.json", ".oms/taxonomy.json", ".oms/types.json"] as const;
    const beforeControls = await Promise.all(controls.map(path => readFile(join(root, path))));
    const unrelatedBefore = await readFile(join(root, "Templates/unrelated.md"));
    const change = {
      templateId: "agent-session",
      sourcePath: "Templates/agent-session.template.md",
      expectedSourceDigest: sha(original),
      renderer: "obsidian-core" as const,
      bytes: new TextEncoder().encode(proposed),
    };

    const planned = await repairPendingTemplateSource(
      { vault: root, source: "explicit" },
      change,
      { dryRun: true },
    );
    expect(planned).toMatchObject({ status: "planned", mode: "update" });
    if (planned.status !== "planned") throw new Error("expected a planned source repair");
    expect(planned.outputs).toContainEqual({
      finalVaultRelativePath: "Templates/agent-session.template.md",
      payloadDigest: sha(proposed),
    });

    const applied = await repairPendingTemplateSource(
      { vault: root, source: "explicit" },
      change,
      { approvedDigest: planned.approvalDigest },
    );
    expect(applied.status).toBe("applied");
    expect(await readFile(join(root, "Templates/agent-session.template.md"), "utf8")).toBe(proposed);
    expect(await readFile(join(root, "Templates/unrelated.md"))).toEqual(unrelatedBefore);
    expect(await Promise.all(controls.map(path => readFile(join(root, path))))).toEqual(beforeControls);
  });

  it("rejects source drift between dry-run and approved apply without overwriting it", async () => {
    const root = await fixture();
    const targetPath = join(root, "Templates/agent-session.template.md");
    const change = {
      templateId: "agent-session",
      sourcePath: "Templates/agent-session.template.md",
      expectedSourceDigest: sha(original),
      renderer: "obsidian-core" as const,
      bytes: new TextEncoder().encode(proposed),
    };
    const planned = await repairPendingTemplateSource(
      { vault: root, source: "explicit" },
      change,
      { dryRun: true },
    );
    if (planned.status !== "planned") throw new Error("expected a planned source repair");
    const drifted = `${original}drift\n`;
    await writeFile(targetPath, drifted);

    await expect(repairPendingTemplateSource(
      { vault: root, source: "explicit" },
      change,
      { approvedDigest: planned.approvalDigest },
    )).rejects.toThrow("TEMPLATE_SOURCE_DRIFT");
    expect(await readFile(targetPath, "utf8")).toBe(drifted);
  });

  it("rejects a stale expected source digest without changing any source", async () => {
    const root = await fixture();
    const targetPath = join(root, "Templates/agent-session.template.md");
    await writeFile(targetPath, `${original}drift\n`);
    const before = await readFile(targetPath);

    await expect(repairPendingTemplateSource(
      { vault: root, source: "explicit" },
      {
        templateId: "agent-session",
        sourcePath: "Templates/agent-session.template.md",
        expectedSourceDigest: sha(original),
        renderer: "obsidian-core",
        bytes: new TextEncoder().encode(proposed),
      },
      { dryRun: true },
    )).rejects.toThrow("TEMPLATE_SOURCE_DRIFT");
    expect(await readFile(targetPath)).toEqual(before);
  });
});
