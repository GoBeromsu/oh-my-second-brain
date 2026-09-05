import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const injectedFault = vi.hoisted(() => ({
  operation: "" as "" | "write" | "remove" | "read",
  suffix: "",
  armed: false,
  skip: 0,
  secondaryOperation: "" as "" | "write" | "remove" | "read",
  secondarySuffix: "",
  secondaryArmed: false,
}));

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const target = (value: Parameters<typeof actual.writeFile>[0]): string => String(value);
  const shouldFail = (operation: typeof injectedFault.operation, value: string): boolean => {
    if (!injectedFault.armed || injectedFault.operation !== operation || !value.endsWith(injectedFault.suffix)) return false;
    if (injectedFault.skip > 0) {
      injectedFault.skip -= 1;
      return false;
    }
    injectedFault.armed = false;
    return true;
  };
  const shouldFailSecondary = (operation: typeof injectedFault.operation, value: string): boolean => {
    if (!injectedFault.secondaryArmed || injectedFault.secondaryOperation !== operation || !value.endsWith(injectedFault.secondarySuffix)) return false;
    injectedFault.secondaryArmed = false;
    return true;
  };
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>): Promise<void> => {
      if (shouldFail("write", target(args[0])) || shouldFailSecondary("write", target(args[0]))) throw new Error("injected write failure");
      await actual.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>): Promise<void> => {
      if (shouldFail("write", String(args[1])) || shouldFailSecondary("write", String(args[1]))) throw new Error("injected rename failure");
      await actual.rename(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>): Promise<void> => {
      if (shouldFail("remove", String(args[0])) || shouldFailSecondary("remove", String(args[0]))) throw new Error("injected remove failure");
      await actual.rm(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...args);
      if (shouldFail("read", String(args[0])) || shouldFailSecondary("read", String(args[0]))) return Buffer.from("injected read-back mismatch");
      return result;
    },
  };
});

import { inputDigest } from "./canonical.js";
import { normalizeTemplateSourcePath } from "./paths.js";
import { serializeDerivedProjection, serializeTemplatePolicy } from "./policy.js";
import { buildTemplateCompositionManifest, sourceSignature } from "./resolver.js";
import { completedTemplateTransaction, executeTemplateTransaction, resumeTemplateTransaction, TEMPLATE_MUTATION_MARKER_PATH } from "./transaction.js";
import type {
  Digest,
  InputV2,
  TemplateBinding,
  TemplateCompositionManifest,
  TemplateCompositionOptions,
  TemplateFolderPath,
  TemplateId,
  TemplatePolicy,
  TemplateSemanticChange,
  TemplateSourcePath,
  TemplateTransactionMarkerPath,
} from "./types.js";

const encoder = new TextEncoder();
const TEMPLATE = "---\ntitle: literal\n---\nBody\n";
const UPDATED = "---\ntitle: changed\n---\nChanged\n";
const TAXONOMY = JSON.stringify({ folders: { Notes: { templates: ["note", "daily", "alpha", "beta", "external", "second", "escape"] } } });
const OBSIDIAN = `${JSON.stringify({ types: { title: "text" } }, null, 2)}\n`;

beforeEach(() => {
  injectedFault.operation = "";
  injectedFault.suffix = "";
  injectedFault.armed = false;
  injectedFault.skip = 0;
  injectedFault.secondaryOperation = "";
  injectedFault.secondarySuffix = "";
  injectedFault.secondaryArmed = false;
});

function digest(value: string | Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;
}
function id(value: string): TemplateId { return value as TemplateId; }
function sourcePath(value: string): TemplateSourcePath { return value as TemplateSourcePath; }
function folder(value: string): TemplateFolderPath { return value as TemplateFolderPath; }
function binding(templateId: string, source: string, destinationClass: TemplateBinding["destinationClass"] = "managed-default"): TemplateBinding {
  const sourceFolder = folder(source.slice(0, source.lastIndexOf("/")));
  return { templateId: id(templateId), destinationClass, renderer: "obsidian-core", sourceFolder, sourcePath: sourcePath(source), contract: "note", naming: "{{title}}" };
}
function policy(bindings: readonly TemplateBinding[], templateFolder = "Templates/OMS", registeredFolders: readonly string[] = []): TemplatePolicy {
  const paths = new Set([templateFolder, "Moved", ...registeredFolders, ...bindings.map(item => item.sourceFolder)]);
  return {
    version: 3,
    templateFolders: [...paths].map(path => ({ path: folder(path), mode: "manual" as const, ...(path === templateFolder ? { default: true as const } : {}) })),
    base: { fields: {} },
    contracts: { note: { intent: "A note.", fields: {}, views: [] } },
    templates: Object.fromEntries(bindings.map(item => [item.templateId, item])),
  };
}
function projection(bindings: readonly TemplateBinding[], policyBytes: string, sourceBytes: Readonly<Record<string, string>>, templateFolder = "Templates/OMS"): string {
  const sources = [
    { logicalId: "template-policy", signature: digest(policyBytes) },
    { logicalId: "taxonomy", signature: digest(TAXONOMY) },
    { logicalId: "obsidian-types", signature: digest(OBSIDIAN) },
    ...bindings.map(item => ({ path: item.sourcePath, signature: digest(sourceBytes[item.templateId] ?? TEMPLATE) })),
  ];
  return serializeDerivedProjection({
    version: "oms.types.v1",
    generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sources), sources },
    managed: {
      base: { fields: {} },
      globalAxes: {},
      templates: Object.fromEntries(bindings.map(item => [item.templateId, {
        templateId: item.templateId,
        destinationClass: item.destinationClass,
        renderer: "obsidian-core",
        sourcePath: item.sourcePath,
        targetFolder: folder("Notes"),
        keyOrder: ["title"],
        fields: { title: { type: "text" } },
        views: [],
        naming: item.naming,
        bodySignature: digest("Body\n"),
      }])),
    },
  });
}

interface VaultFixture {
  readonly vault: string;
  readonly bindings: readonly TemplateBinding[];
  readonly policyBytes: string;
  readonly projectionBytes: string;
  readonly options: TemplateCompositionOptions;
}

async function fixture(bindings: readonly TemplateBinding[] = [], sourceBytes: Readonly<Record<string, string>> = {}, registeredFolders: readonly string[] = []): Promise<VaultFixture> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-transaction-"));
  await mkdir(path.join(vault, ".oms"), { recursive: true });
  await mkdir(path.join(vault, ".obsidian"), { recursive: true });
  const policyBytes = serializeTemplatePolicy(policy(bindings, "Templates/OMS", registeredFolders));
  const projectionBytes = projection(bindings, policyBytes, sourceBytes);
  await Promise.all([
    writeFile(path.join(vault, ".oms", "template-policy.json"), policyBytes),
    writeFile(path.join(vault, ".oms", "taxonomy.json"), TAXONOMY),
    writeFile(path.join(vault, ".oms", "types.json"), projectionBytes),
    writeFile(path.join(vault, ".obsidian", "types.json"), OBSIDIAN),
  ]);
  for (const item of bindings) {
    const content = sourceBytes[item.templateId] ?? TEMPLATE;
    await mkdir(path.dirname(path.join(vault, item.sourcePath)), { recursive: true });
    await writeFile(path.join(vault, item.sourcePath), content);
  }
  const input: InputV2 = {
    version: 2,
    templateFolders: policy(bindings, "Templates/OMS", registeredFolders).templateFolders,
    authority: [
      { kind: "policy", logicalId: "template-policy", vaultRelativePath: ".oms/template-policy.json", contentDigest: digest(policyBytes) },
      { kind: "taxonomy", logicalId: "taxonomy", vaultRelativePath: ".oms/taxonomy.json", contentDigest: digest(TAXONOMY) },
      { kind: "obsidian-types", logicalId: "obsidian-types", vaultRelativePath: ".obsidian/types.json", contentDigest: digest(OBSIDIAN) },
      ...bindings.map(item => ({ kind: "template" as const, logicalId: item.templateId, vaultRelativePath: item.sourcePath, contentDigest: digest(sourceBytes[item.templateId] ?? TEMPLATE) })),
    ],
    placement: bindings.map(item => ({ templateId: item.templateId, destinationClass: item.destinationClass, templateFolder: item.destinationClass === "managed-default" ? item.sourceFolder : null, sourceFolder: item.sourceFolder, sourcePath: item.sourcePath })),
  };
  return {
    vault,
    bindings,
    policyBytes,
    projectionBytes,
    options: {
      expected: {
        input: inputDigest(input),
        controls: {
          policy: { state: "present", signature: digest(policyBytes) },
          taxonomy: { state: "present", signature: digest(TAXONOMY) },
          projection: { state: "present", signature: digest(projectionBytes) },
        },
        sources: bindings.map(item => ({ templateId: item.templateId, path: item.sourcePath, expected: { state: "present", signature: digest(sourceBytes[item.templateId] ?? TEMPLATE) } })),
      },
      taxonomy: { expectedCurrent: { state: "present", signature: digest(TAXONOMY) }, proposedBytes: encoder.encode(TAXONOMY), action: "verify-only" },
    },
  };
}

async function tree(vault: string): Promise<readonly [string, string][]> {
  const entries: Array<[string, string]> = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(vault, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) await walk(absolute);
      else entries.push([relative, (await readFile(absolute)).toString("hex")]);
    }
  }
  await walk(vault);
  return entries.sort(([left], [right]) => left.localeCompare(right));
}
async function compose(item: VaultFixture, change: TemplateSemanticChange): Promise<TemplateCompositionManifest> {
  return buildTemplateCompositionManifest(item.vault, change, item.options);
}
async function cleanup(item: VaultFixture): Promise<void> { await rm(item.vault, { recursive: true, force: true }); }
function createChange(templateId = "daily"): TemplateSemanticChange {
  const item = binding(templateId, `Templates/OMS/${templateId}.md`);
  return { mode: "create", binding: item, source: { path: item.sourcePath, bytes: encoder.encode(TEMPLATE), publication: "write" } };
}
function rejectedCode(receipt: Awaited<ReturnType<typeof executeTemplateTransaction>>): string | undefined {
  return receipt.status === "rejected" || receipt.status === "inconsistent" ? receipt.diagnostics[0]?.code : undefined;
}
function nextOptions(manifest: TemplateCompositionManifest): TemplateCompositionOptions {
  const [policyControl, taxonomyControl, projectionControl] = manifest.controls;
  return {
    expected: {
      input: manifest.proposed.inputDigest,
      controls: {
        policy: { state: "present", signature: policyControl.proposed.signature },
        taxonomy: { state: "present", signature: taxonomyControl.proposed.signature },
        projection: { state: "present", signature: projectionControl.proposed.signature },
      },
      sources: manifest.proposed.resolvedTemplates.map(template => ({
        templateId: template.templateId,
        path: template.sourcePath,
        expected: { state: "present", signature: template.templateSignature },
      })),
    },
    taxonomy: {
      expectedCurrent: { state: "present", signature: taxonomyControl.proposed.signature },
      proposedBytes: new Uint8Array(taxonomyControl.proposed.bytes),
      action: "verify-only",
    },
  };
}
function markerTypeContract(
  vault: string,
  manifest: TemplateCompositionManifest,
  request: { readonly approvedDigest: Digest },
): void {
  // @ts-expect-error Marker paths are a closed exported union.
  void executeTemplateTransaction(vault, manifest, request, ".oms/arbitrary.json");
}
void markerTypeContract;
function inject(operation: "write" | "remove" | "read", suffix: string, skip = 0): void {
  injectedFault.operation = operation;
  injectedFault.suffix = suffix;
  injectedFault.skip = skip;
  injectedFault.armed = true;
}
function injectSecondary(operation: "write" | "remove" | "read", suffix: string): void {
  injectedFault.secondaryOperation = operation;
  injectedFault.secondarySuffix = suffix;
  injectedFault.secondaryArmed = true;
}

describe("guarded template transactions", () => {
  it("creates through dry-run, approved apply, and exact read-back", async () => {
    const item = await fixture();
    try {
      const manifest = await compose(item, createChange());
      const before = await tree(item.vault);
      const planned = await executeTemplateTransaction(item.vault, manifest, { dryRun: true });
      expect(planned.status).toBe("planned");
      expect(await tree(item.vault)).toEqual(before);
      const applied = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
      expect(applied.status).toBe("applied");
      expect(await readFile(path.join(item.vault, "Templates/OMS/daily.md"), "utf8")).toBe(TEMPLATE);
      if (applied.status === "applied") expect(applied.verified.every(result => result.state === "present")).toBe(true);
    } finally { await cleanup(item); }
  });

  it("rejects a wrong approval before lock, marker, staging, or final bytes", async () => {
    const item = await fixture();
    try {
      const manifest = await compose(item, createChange());
      const before = await tree(item.vault);
      const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: digest("wrong") });
      expect(rejectedCode(receipt)).toBe("MIGRATION_APPROVAL_MISMATCH");
      expect(await tree(item.vault)).toEqual(before);
      await expect(readdir(path.join(item.vault, ".oms/.template-transactions"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(item.vault, ".oms/template-migration.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await cleanup(item); }
  });

  it("rejects missing apply approval and dry-run carrying approval without mutation", async () => {
    const item = await fixture();
    try {
      const manifest = await compose(item, createChange());
      const before = await tree(item.vault);
      const missing = await executeTemplateTransaction(item.vault, manifest, {} as Parameters<typeof executeTemplateTransaction>[2]);
      const mixed = await executeTemplateTransaction(item.vault, manifest, { dryRun: true, approvedDigest: manifest.approvalDigest } as Parameters<typeof executeTemplateTransaction>[2]);
      expect(rejectedCode(missing)).toBe("MIGRATION_APPROVAL_MISMATCH");
      expect(rejectedCode(mixed)).toBe("MIGRATION_APPROVAL_MISMATCH");
      expect(await tree(item.vault)).toEqual(before);
    } finally { await cleanup(item); }
  });

  it("rejects malformed v3 folder input as an invalid manifest without mutation", async () => {
    const item = await fixture();
    try {
      const manifest = await compose(item, createChange());
      const before = await tree(item.vault);
      const malformed = {
        ...manifest,
        current: {
          ...manifest.current,
          input: { ...manifest.current.input, templateFolders: [{ path: "../escape", mode: "manual" }] },
        },
      } as unknown as TemplateCompositionManifest;
      expect(rejectedCode(await executeTemplateTransaction(item.vault, malformed, { dryRun: true }))).toBe("TEMPLATE_TRANSACTION_MANIFEST_INVALID");
      expect(await tree(item.vault)).toEqual(before);
    } finally { await cleanup(item); }
  });

  it("rejects a manifest whose approved current-control preimage was replaced", async () => {
    const item = await fixture();
    try {
      const manifest = await compose(item, createChange());
      const before = await tree(item.vault);
      const [policyControl, taxonomyControl, projectionControl] = manifest.controls;
      const tampered = {
        ...manifest,
        controls: [
          { ...policyControl, expectedCurrent: { state: "present", signature: digest("different old policy") } },
          taxonomyControl,
          projectionControl,
        ],
      } as TemplateCompositionManifest;
      expect(rejectedCode(await executeTemplateTransaction(item.vault, tampered, { approvedDigest: manifest.approvalDigest }))).toBe("TEMPLATE_TRANSACTION_MANIFEST_INVALID");
      expect(await tree(item.vault)).toEqual(before);
    } finally { await cleanup(item); }
  });

  it("does not steal a live transaction lock", async () => {
    const item = await fixture();
    try {
      const manifest = await compose(item, createChange());
      const id = createHash("sha256").update(`${manifest.approvalDigest}\0${manifest.outputDigest}`).digest("hex").slice(0, 32);
      const lock = path.join(item.vault, ".oms", ".template-transactions", id, "template-migration", "lock");
      await mkdir(lock, { recursive: true });
      await writeFile(path.join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, token: "live-owner" })}\n`);
      const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
      expect(rejectedCode(receipt)).toBe("MIGRATION_RETRY_MISMATCH");
      expect(await readFile(path.join(lock, "owner.json"), "utf8")).toContain("live-owner");
    } finally { await cleanup(item); }
  });

  it("rejects stale control and source CAS with whole-tree equality", async () => {
    const current = binding("note", "Templates/OMS/note.md");
    const item = await fixture([current]);
    try {
      const change: TemplateSemanticChange = { mode: "update", templateId: current.templateId, binding: current, source: { path: current.sourcePath, bytes: encoder.encode(UPDATED), publication: "write" } };
      const manifest = await compose(item, change);
      await writeFile(path.join(item.vault, "Templates/OMS/note.md"), "external\n");
      const before = await tree(item.vault);
      const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
      expect(rejectedCode(receipt)).toBe("MIGRATION_APPROVAL_MISMATCH");
      expect(await tree(item.vault)).toEqual(before);
    } finally { await cleanup(item); }
  });

  it("rejects stale control CAS with whole-tree equality", async () => {
    const item = await fixture();
    try {
      const manifest = await compose(item, createChange());
      await writeFile(path.join(item.vault, ".oms/types.json"), "{}\n");
      const before = await tree(item.vault);
      const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
      expect(rejectedCode(receipt)).toBe("MIGRATION_APPROVAL_MISMATCH");
      expect(await tree(item.vault)).toEqual(before);
    } finally { await cleanup(item); }
  });

  it("rejects stale expected input during composition without mutation", async () => {
    const item = await fixture();
    try {
      const before = await tree(item.vault);
      const stale: TemplateCompositionOptions = {
        ...item.options,
        expected: { ...item.options.expected, input: digest("stale-input") },
      };
      await expect(buildTemplateCompositionManifest(item.vault, createChange(), stale)).rejects.toThrow(/input CAS does not match/);
      expect(await tree(item.vault)).toEqual(before);
    } finally { await cleanup(item); }
  });

  it("updates content at the same path using source CAS", async () => {
    const current = binding("note", "Templates/OMS/note.md");
    const item = await fixture([current]);
    try {
      const manifest = await compose(item, { mode: "update", templateId: current.templateId, binding: current, source: { path: current.sourcePath, bytes: encoder.encode(UPDATED), publication: "write" } });
      const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
      expect(receipt.status).toBe("applied");
      expect(await readFile(path.join(item.vault, current.sourcePath), "utf8")).toBe(UPDATED);
    } finally { await cleanup(item); }
  });

  it("moves by oms-managed-rename and removes the old source", async () => {
    const current = binding("note", "Templates/OMS/note.md");
    const proposed = binding("note", "Archive/note.md", "registered-existing");
    const item = await fixture([current], {}, ["Archive"]);
    try {
      const manifest = await compose(item, { mode: "update", templateId: current.templateId, binding: proposed, source: { path: proposed.sourcePath, bytes: encoder.encode(TEMPLATE), publication: "write" }, moveStrategy: "oms-managed-rename" });
      const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
      expect(receipt.status).toBe("applied");
      await expect(readFile(path.join(item.vault, current.sourcePath))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(item.vault, proposed.sourcePath), "utf8")).toBe(TEMPLATE);
    } finally { await cleanup(item); }
  });

  it("registers an already-moved source without rewriting it", async () => {
    const current = binding("note", "Templates/OMS/note.md");
    const proposed = binding("note", "External/note.md", "registered-existing");
    const item = await fixture([current], {}, ["External"]);
    try {
      await rm(path.join(item.vault, current.sourcePath));
      await mkdir(path.dirname(path.join(item.vault, proposed.sourcePath)), { recursive: true });
      await writeFile(path.join(item.vault, proposed.sourcePath), TEMPLATE);
      const options: TemplateCompositionOptions = {
        ...item.options,
        expected: {
          ...item.options.expected,
          sources: [{ templateId: current.templateId, path: current.sourcePath, expected: { state: "absent" } }],
        },
      };
      const manifest = await buildTemplateCompositionManifest(item.vault, { mode: "update", templateId: current.templateId, binding: proposed, source: { path: proposed.sourcePath, bytes: encoder.encode(TEMPLATE), publication: "verify-existing" }, moveStrategy: "register-already-moved" }, options);
      const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
      expect(receipt.status).toBe("applied");
      expect(await readFile(path.join(item.vault, proposed.sourcePath), "utf8")).toBe(TEMPLATE);
    } finally { await cleanup(item); }
  });

  it("rejects a move collision during composition without mutation", async () => {
    const current = binding("note", "Templates/OMS/note.md");
    const proposed = binding("note", "Archive/note.md", "registered-existing");
    const item = await fixture([current], {}, ["Archive"]);
    try {
      await mkdir(path.dirname(path.join(item.vault, proposed.sourcePath)), { recursive: true });
      await writeFile(path.join(item.vault, proposed.sourcePath), "collision\n");
      const before = await tree(item.vault);
      await expect(compose(item, { mode: "update", templateId: current.templateId, binding: proposed, source: { path: proposed.sourcePath, bytes: encoder.encode(TEMPLATE), publication: "write" }, moveStrategy: "oms-managed-rename" })).rejects.toThrow(/collides/);
      expect(await tree(item.vault)).toEqual(before);
    } finally { await cleanup(item); }
  });

  it("reclassifies at the same path through controls only", async () => {
    const current = binding("note", "Templates/OMS/note.md");
    const item = await fixture([current]);
    try {
      const manifest = await compose(item, { mode: "reclassify", templateId: current.templateId, toClass: "registered-existing" });
      const signature = manifest.current.resolvedTemplates[0]!.templateSignature;
      const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
      expect(receipt.status).toBe("applied");
      if (receipt.status === "applied") expect(receipt.writtenPaths).not.toContain(current.sourcePath);
      expect(await readFile(path.join(item.vault, current.sourcePath), "utf8")).toBe(TEMPLATE);
      expect(manifest.proposed.resolvedTemplates[0]!.templateSignature).toBe(signature);
    } finally { await cleanup(item); }
  });

  it("rejects reclassify path mismatch and returns unchanged for same class", async () => {
    const registered = binding("note", "External/custom.md", "registered-existing");
    const item = await fixture([registered]);
    try {
      const before = await tree(item.vault);
      await expect(compose(item, { mode: "reclassify", templateId: registered.templateId, toClass: "managed-default" })).rejects.toThrow(/TEMPLATE_RECLASSIFY_PATH_MISMATCH/);
      expect(await tree(item.vault)).toEqual(before);
      const manifest = await compose(item, { mode: "reclassify", templateId: registered.templateId, toClass: "registered-existing" });
      expect((await executeTemplateTransaction(item.vault, manifest, { dryRun: true })).status).toBe("unchanged");
    } finally { await cleanup(item); }
  });

  it("returns unchanged for relocate-folder N=0", async () => {
    const item = await fixture();
    try {
      const manifest = await compose(item, { mode: "relocate-folder", templateFolder: folder("Moved") });
      expect(manifest.moves).toEqual([]);
      expect((await executeTemplateTransaction(item.vault, manifest, { dryRun: true })).status).toBe("unchanged");
    } finally { await cleanup(item); }
  });

  it("relocates two managed templates in deterministic order and leaves registered-existing untouched", async () => {
    const bindings = [binding("beta", "Templates/OMS/beta.md"), binding("alpha", "Templates/OMS/alpha.md"), binding("external", "External/external.md", "registered-existing")];
    const item = await fixture(bindings);
    try {
      const manifest = await compose(item, { mode: "relocate-folder", templateFolder: folder("Moved") });
      expect(manifest.moves.map(move => move.templateId)).toEqual(["alpha", "beta"]);
      const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
      expect(receipt.status).toBe("applied");
      expect(await readFile(path.join(item.vault, "Moved/alpha.md"), "utf8")).toBe(TEMPLATE);
      expect(await readFile(path.join(item.vault, "Moved/beta.md"), "utf8")).toBe(TEMPLATE);
      expect(await readFile(path.join(item.vault, "External/external.md"), "utf8")).toBe(TEMPLATE);
    } finally { await cleanup(item); }
  });

  it("retains relocation no-op moves without publishing source bytes", async () => {
    const current = binding("note", "Templates/OMS/note.md");
    const item = await fixture([current]);
    try {
      const manifest = await compose(item, { mode: "relocate-folder", templateFolder: folder("Templates/OMS") });
      expect(manifest.moves).toMatchObject([{ templateId: "note", strategy: "no-op" }]);
      expect((await executeTemplateTransaction(item.vault, manifest, { dryRun: true })).status).toBe("unchanged");
    } finally { await cleanup(item); }
  });

  it.each([
    ["new-source publish", "write", "Moved/alpha.md", 1],
    ["control replace", "write", ".oms/template-policy.json", 1],
    ["old-source delete", "remove", "Templates/OMS/alpha.md", 0],
    ["read-back", "read", "Moved/alpha.md", 0],
  ] as const)("rolls back relocate-folder failure at %s and retries identically", async (_boundary, operation, suffix, skip) => {
    const bindings = [binding("alpha", "Templates/OMS/alpha.md"), binding("beta", "Templates/OMS/beta.md")];
    const item = await fixture(bindings);
    try {
      const manifest = await compose(item, { mode: "relocate-folder", templateFolder: folder("Moved") });
      const before = await tree(item.vault);
      inject(operation, suffix, skip);
      const failed = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
      expect(rejectedCode(failed)).toBe("MIGRATION_PUBLISHED_OUTPUT_CONFLICT");
      expect(await tree(item.vault)).toEqual(before);
      const retried = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
      expect(retried.status).toBe("applied");
      if (retried.status === "applied") expect(retried.outputDigest).toBe(manifest.outputDigest);
    } finally { await cleanup(item); }
  });

  it("returns inconsistent and retains fail-closed state when rollback fails", async () => {
    const bindings = [binding("alpha", "Templates/OMS/alpha.md"), binding("beta", "Templates/OMS/beta.md")];
    const item = await fixture(bindings);
    try {
      const manifest = await compose(item, { mode: "relocate-folder", templateFolder: folder("Moved") });
      inject("write", ".oms/template-policy.json", 1);
      injectSecondary("remove", "Moved/beta.md");
      const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
      expect(receipt.status).toBe("inconsistent");
      expect(await readFile(path.join(item.vault, ".oms/template-migration.json"), "utf8")).toContain('"status":"in-progress"');
    } finally { await cleanup(item); }
  });

  it("resumes an identical in-progress relocation to the same output digest", async () => {
    const bindings = [binding("alpha", "Templates/OMS/alpha.md"), binding("beta", "Templates/OMS/beta.md")];
    const item = await fixture(bindings);
    try {
      const manifest = await compose(item, { mode: "relocate-folder", templateFolder: folder("Moved") });
      const transactionId = createHash("sha256").update(`${manifest.approvalDigest}\0${manifest.outputDigest}`).digest("hex").slice(0, 32);
      inject("write", ".oms/template-policy.json", 1);
      injectSecondary("remove", "Moved/beta.md");
      expect((await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest })).status).toBe("inconsistent");
      const receipt = await resumeTemplateTransaction(item.vault, transactionId, manifest.approvalDigest);
      expect(receipt.status).toBe("applied");
      if (receipt.status === "applied") {
        expect(receipt.transactionId).toBe(transactionId);
        expect(receipt.outputDigest).toBe(manifest.outputDigest);
      }
      expect(await readFile(path.join(item.vault, "Moved/beta.md"), "utf8")).toBe(TEMPLATE);
    } finally { await cleanup(item); }
  });

  it("resumes a failed current JSON control transaction while leaving legacy YAML untouched", async () => {
    const bindings = [binding("alpha", "Templates/OMS/alpha.md"), binding("beta", "Templates/OMS/beta.md")];
    const item = await fixture(bindings);
    try {
      const yamlPath = path.join(item.vault, ".oms", "taxonomy.yaml");
      await writeFile(yamlPath, "folders: {}\n");
      const manifest = await compose(item, { mode: "relocate-folder", templateFolder: folder("Moved") });
      const transactionId = createHash("sha256").update(`${manifest.approvalDigest}\0${manifest.outputDigest}`).digest("hex").slice(0, 32);

      inject("write", ".oms/template-policy.json", 1);
      injectSecondary("remove", "Moved/beta.md");
      expect((await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest })).status).toBe("inconsistent");
      expect(await readFile(yamlPath, "utf8")).toBe("folders: {}\n");

      const receipt = await resumeTemplateTransaction(item.vault, transactionId, manifest.approvalDigest);
      expect(receipt.status).toBe("applied");
      if (receipt.status === "applied") {
        expect(receipt.transactionId).toBe(transactionId);
        expect(receipt.outputDigest).toBe(manifest.outputDigest);
        expect(receipt.markerState).toBe("complete");
      }
      expect(await readFile(path.join(item.vault, ".oms", "taxonomy.json"), "utf8")).toBe(TAXONOMY);
      expect(await readFile(yamlPath, "utf8")).toBe("folders: {}\n");
    } finally { await cleanup(item); }
  });

  it("keeps completed migration, routine mutation, and regenerate marker families independent", async () => {
    const item = await fixture();
    try {
      const created = await compose(item, createChange());
      expect((await executeTemplateTransaction(item.vault, created, { approvedDigest: created.approvalDigest })).status).toBe("applied");
      const migrationHistory = await readFile(path.join(item.vault, ".oms/template-migration.json"), "utf8");

      const current = created.proposed.bindings[0]!;
      const backfill = await buildTemplateCompositionManifest(item.vault, {
        mode: "update",
        templateId: current.templateId,
        binding: current,
        source: { path: current.sourcePath, bytes: encoder.encode(UPDATED), publication: "write" },
      }, nextOptions(created));
      const backfillMarker: TemplateTransactionMarkerPath = TEMPLATE_MUTATION_MARKER_PATH;
      const backfillApplied = await executeTemplateTransaction(item.vault, backfill, { approvedDigest: backfill.approvalDigest }, backfillMarker);
      expect(backfillApplied.status).toBe("applied");
      expect(await readFile(path.join(item.vault, ".oms/template-migration.json"), "utf8")).toBe(migrationHistory);
      expect(await readFile(path.join(item.vault, backfillMarker), "utf8")).toContain('"status":"complete"');
      if (backfillApplied.status === "applied") expect(backfillApplied.writtenPaths).not.toContain(backfillMarker);

      const regenerated = await buildTemplateCompositionManifest(item.vault, {
        mode: "update",
        templateId: current.templateId,
        binding: current,
        source: { path: current.sourcePath, bytes: encoder.encode(TEMPLATE), publication: "write" },
      }, nextOptions(backfill));
      const regenerateMarker: TemplateTransactionMarkerPath = ".oms/template-regenerate.json";
      expect((await executeTemplateTransaction(item.vault, regenerated, { approvedDigest: regenerated.approvalDigest }, regenerateMarker)).status).toBe("applied");
      expect(await readFile(path.join(item.vault, regenerateMarker), "utf8")).toContain('"status":"complete"');
    } finally { await cleanup(item); }
  });

  it("retries each selected marker family independently", async () => {
    for (const marker of [
      ".oms/template-migration.json",
      ".oms/template-backfill.json",
      ".oms/template-regenerate.json",
    ] as const) {
      const item = await fixture();
      try {
        const manifest = await compose(item, createChange());
        const first = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest }, marker);
        const before = await tree(item.vault);
        const retry = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest }, marker);
        expect(first.status).toBe("applied");
        expect(retry.status).toBe("already-complete");
        expect(await tree(item.vault)).toEqual(before);
      } finally { await cleanup(item); }
    }
  });

  it("rejects untyped arbitrary marker paths at runtime", async () => {
    const item = await fixture();
    try {
      const manifest = await compose(item, createChange());
      const before = await tree(item.vault);
      await expect(executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest }, ".oms/arbitrary.json" as unknown as TemplateTransactionMarkerPath)).rejects.toThrow(/marker path is not approved/);
      expect(await tree(item.vault)).toEqual(before);
    } finally { await cleanup(item); }
  });

  it("returns already-complete with stable identity and zero retry mutation", async () => {
    const item = await fixture();
    try {
      const manifest = await compose(item, createChange());
      const first = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
      expect(first.status).toBe("applied");
      const before = await tree(item.vault);
      const retry = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
      expect(retry.status).toBe("already-complete");
      if (first.status === "applied" && retry.status === "already-complete") {
        expect(retry.transactionId).toBe(first.transactionId);
        expect(retry.outputDigest).toBe(first.outputDigest);
      }
      expect(await tree(item.vault)).toEqual(before);
    } finally { await cleanup(item); }
  });

  it("materializes only a verified completed receipt for its approved digest", async () => {
    const item = await fixture();
    try {
      const manifest = await compose(item, createChange());
      const applied = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
      expect(applied.status).toBe("applied");

      const completed = await completedTemplateTransaction(item.vault, manifest.approvalDigest, {
        inputDigest: manifest.proposed.inputDigest,
        outputs: manifest.outputs.map((output) => ({ finalVaultRelativePath: output.finalVaultRelativePath })),
      });

      expect(completed?.transactionId).toBe(createHash("sha256").update(`${manifest.approvalDigest}\0${manifest.outputDigest}`).digest("hex").slice(0, 32));
      expect(completed?.inputDigest).toBe(manifest.proposed.inputDigest);
      expect(completed?.outputDigest).toBe(manifest.outputDigest);
      expect(await completedTemplateTransaction(item.vault, digest("different"), {
        inputDigest: manifest.proposed.inputDigest,
        outputs: manifest.outputs.map((output) => ({ finalVaultRelativePath: output.finalVaultRelativePath })),
      })).toBeNull();
    } finally { await cleanup(item); }
  });

  it("rejects a completed transaction when only its input digest differs", async () => {
    const item = await fixture();
    try {
      const manifest = await compose(item, createChange());
      expect((await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest })).status).toBe("applied");
      expect(await completedTemplateTransaction(item.vault, manifest.approvalDigest, {
        inputDigest: digest("different-input"),
        outputs: manifest.outputs.map((output) => ({ finalVaultRelativePath: output.finalVaultRelativePath })),
      })).toBeNull();
    } finally { await cleanup(item); }
  });

  it.each([
    [".oms/template-policy.json", async (vault: string, requested: TemplateSourcePath, other: TemplateSourcePath): Promise<void> => { await writeFile(path.join(vault, ".oms/template-policy.json"), "drift"); }],
    [".oms/taxonomy.json", async (vault: string, requested: TemplateSourcePath, other: TemplateSourcePath): Promise<void> => { await writeFile(path.join(vault, ".oms/taxonomy.json"), "drift"); }],
    [".oms/types.json", async (vault: string, requested: TemplateSourcePath, other: TemplateSourcePath): Promise<void> => { await writeFile(path.join(vault, ".oms/types.json"), "drift"); }],
    ["the requested source", async (vault: string, requested: TemplateSourcePath, other: TemplateSourcePath): Promise<void> => { await writeFile(path.join(vault, requested), UPDATED); }],
    ["a different registered source", async (vault: string, requested: TemplateSourcePath, other: TemplateSourcePath): Promise<void> => { await writeFile(path.join(vault, other), UPDATED); }],
  ])("rejects a completed transaction after drift in %s", async (_name, mutate) => {
    const item = await fixture();
    try {
      const first = await compose(item, createChange());
      expect((await executeTemplateTransaction(item.vault, first, { approvedDigest: first.approvalDigest })).status).toBe("applied");
      const other = first.proposed.bindings[0]!;
      const requested = binding("second", "Templates/OMS/second.md", "managed-default");
      const second = await buildTemplateCompositionManifest(item.vault, {
        mode: "create",
        binding: requested,
        source: { path: requested.sourcePath, bytes: encoder.encode(TEMPLATE), publication: "write" },
      }, nextOptions(first));
      expect((await executeTemplateTransaction(item.vault, second, { approvedDigest: second.approvalDigest })).status).toBe("applied");
      await mutate(item.vault, requested.sourcePath, other.sourcePath);
      expect(await completedTemplateTransaction(item.vault, second.approvalDigest, {
        inputDigest: second.proposed.inputDigest,
        outputs: second.outputs.map((output) => ({ finalVaultRelativePath: output.finalVaultRelativePath })),
      })).toBeNull();
    } finally { await cleanup(item); }
  });

  it("replaces a completed marker with a distinct approved transaction", async () => {
    const item = await fixture();
    try {
      const created = await compose(item, createChange());
      expect((await executeTemplateTransaction(item.vault, created, { approvedDigest: created.approvalDigest })).status).toBe("applied");
      const current = created.proposed.bindings[0]!;
      const updated = await buildTemplateCompositionManifest(item.vault, {
        mode: "update",
        templateId: current.templateId,
        binding: current,
        source: { path: current.sourcePath, bytes: encoder.encode(UPDATED), publication: "write" },
      }, nextOptions(created));
      const receipt = await executeTemplateTransaction(item.vault, updated, { approvedDigest: updated.approvalDigest });
      expect(receipt.status).toBe("applied");
      expect(await readFile(path.join(item.vault, ".oms/template-migration.json"), "utf8")).toContain(`"transactionId":"${createHash("sha256").update(`${updated.approvalDigest}\0${updated.outputDigest}`).digest("hex").slice(0, 32)}"`);
    } finally { await cleanup(item); }
  });

  it("fails closed for a malformed active marker before publication", async () => {
    const item = await fixture();
    try {
      const manifest = await compose(item, createChange());
      await writeFile(path.join(item.vault, ".oms/template-migration.json"), "{\"status\":\"in-progress\"}\n");
      const before = await tree(item.vault);
      expect(rejectedCode(await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest }))).toBe("migration-incomplete");
      expect(await tree(item.vault)).toEqual(before);
    } finally { await cleanup(item); }
  });

  it("rejects symlink escape and hidden/internal template source paths", async () => {
    const item = await fixture([], {}, ["Templates"]);
    const outside = await mkdtemp(path.join(tmpdir(), "oms-outside-"));
    try {
      await writeFile(path.join(outside, "escape.md"), TEMPLATE);
      await mkdir(path.join(item.vault, "Templates"), { recursive: true });
      await symlink(path.join(outside, "escape.md"), path.join(item.vault, "Templates", "escape.md"));
      const escaped = binding("escape", "Templates/escape.md", "registered-existing");
      const before = await tree(item.vault);
      await expect(compose(item, { mode: "create", binding: escaped, source: { path: escaped.sourcePath, bytes: encoder.encode(TEMPLATE), publication: "verify-existing" } })).rejects.toThrow(/TEMPLATE_SOURCE_UNSAFE/);
      expect(() => normalizeTemplateSourcePath(".oms/template-policy.json")).toThrow(/TEMPLATE_SOURCE_UNSAFE/);
      expect(() => normalizeTemplateSourcePath(".template-transactions/stage.md")).toThrow(/TEMPLATE_SOURCE_UNSAFE/);
      expect(await tree(item.vault)).toEqual(before);
    } finally { await cleanup(item); await rm(outside, { recursive: true, force: true }); }
  });
});
