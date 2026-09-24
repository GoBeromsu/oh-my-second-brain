import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile, type FileHandle } from "node:fs/promises";
import fs, { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalDigest, digestBytes, hashCanonical, outputDigest } from "./canonical.js";
import { serializeContractPolicyV5, type ContractPolicyV5 } from "./contract-v5.js";
import { VAULT_PUBLICATION_LEASE, acquireTransactionLock, releaseTransactionLock } from "./file-lock.js";
import { inspectLegacyPublicationMarker, legacyPublicationReadSet, verifyLegacyPublicationEvidence, type LegacyPublicationEvidenceInput } from "./legacy-publication-evidence.js";
import { executeTemplateTransaction, TEMPLATE_TRANSACTION_MARKER_PATH } from "./transaction.js";
import type { ManagedDraftTransition, ManagedTemplatePath, TemplateCompositionManifest, TemplateId, TemplateTransactionReceipt } from "./types.js";
import { commitVaultPublication, inspectLegacyVaultPublication, planVaultPublication, verifiedLegacyVaultSource } from "./vault-publication.js";

const roots: string[] = [];
const publication = JSON.parse(readFileSync(new URL("../../../test/fixtures/contract-migrations/publication.json", import.meta.url), "utf8")) as {
  readonly classification: string;
  readonly producerAttribution: string;
  readonly notCapturedTransaction: boolean;
  readonly v3: Record<string, unknown>;
  readonly v3Ordered: Record<string, unknown>;
  readonly v3Canonical: Record<string, unknown>;
  readonly v4: Record<string, unknown>;
  readonly v4FieldOnly: Record<string, unknown>;
};
const VAULT_ID = "11111111-1111-4111-8111-111111111111";
const TX_ID = "22222222-2222-4222-8222-222222222222";
const POLICY = ".oms/template-policy.json";
const TAXONOMY = ".oms/taxonomy.json";
const PROJECTION = ".oms/types.json";
const DRAFT = ".oms/templates/default.md" as ManagedTemplatePath;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function decoded(value: string): Buffer {
  return Buffer.from(value, "base64");
}
function section(name: "v3" | "v3Ordered" | "v3Canonical" | "v4" | "v4FieldOnly") {
  const raw = publication[name];
  const observed = raw["observedBase64"] as Record<string, string>;
  return {
    format: name.startsWith("v3") ? "v3" as const : "v4" as const,
    markerPath: String(raw["markerPath"]),
    markerBytes: String(raw["markerText"]),
    planPath: String(raw["planPath"]),
    planBytes: String(raw["planText"]),
    policy: decoded(String(raw["policyBase64"])),
    observed: Object.fromEntries(Object.entries(observed).map(([path, encoded]) => [path, decoded(encoded)])),
  };
}
async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-legacy-admission-"));
  roots.push(root);
  return realpath(root);
}
function observeHandles(visit: (file: string, handle: FileHandle) => void): () => void {
  const original = fs.promises.open;
  const spy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await original(...args);
    visit(String(args[0]), handle);
    return handle;
  });
  syncBuiltinESMExports();
  return () => {
    spy.mockRestore();
    syncBuiltinESMExports();
  };
}
type ChunkRead = (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }>;
async function install(name: "v3" | "v3Ordered" | "v3Canonical" | "v4" | "v4FieldOnly"): Promise<string> {
  const root = await vault();
  const item = section(name);
  const files: Record<string, Buffer> = {
    [item.markerPath]: Buffer.from(item.markerBytes),
    [item.planPath]: Buffer.from(item.planBytes),
    ...item.observed,
  };
  for (const [relativePath, bytes] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, bytes);
  }
  return root;
}
async function tree(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) found[absolute.slice(root.length + 1).replaceAll("\\", "/")] = "symlink";
      else if (entry.isFIFO()) found[absolute.slice(root.length + 1).replaceAll("\\", "/")] = "fifo";
      else if (entry.isDirectory()) await walk(absolute);
      else found[absolute.slice(root.length + 1).replaceAll("\\", "/")] = (await readFile(absolute)).toString("base64");
    }
  }
  await walk(root);
  return found;
}
function withoutLease(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([path]) => !path.startsWith(".oms/.template-transactions/vault-lock/")));
}
function evidence(name: "v3" | "v3Ordered" | "v3Canonical" | "v4" | "v4FieldOnly"): LegacyPublicationEvidenceInput {
  const item = section(name);
  return {
    format: item.format,
    markerPath: item.markerPath,
    markerBytes: item.markerBytes,
    planPath: item.planPath,
    planBytes: item.planBytes,
    policyBytes: item.policy,
    observedOutputs: item.observed,
  };
}
function v5(revision: number): ContractPolicyV5 {
  return { version: 5, revision, properties: { title: { type: "text" } }, common: { status: "active", fields: { title: { required: revision > 0 } } }, templates: {} };
}
async function publicationFixture() {
  const root = await vault();
  await mkdir(join(root, ".oms"));
  const before = serializeContractPolicyV5(v5(0));
  const after = serializeContractPolicyV5(v5(1));
  await writeFile(join(root, POLICY), before);
  const target = { vault: root, source: "explicit" as const };
  const history = `${JSON.stringify({ version: 1, transactionId: TX_ID, kind: "publication", revision: 1, previousPolicyDigest: digestBytes(before), policyDigest: digestBytes(after), decision: "approved exact policy diff" })}\n`;
  const plan = await planVaultPublication(target, {
    kind: "contract-publication",
    vaultId: VAULT_ID,
    transactionId: TX_ID,
    outputs: [
      { path: POLICY, expectedDigest: digestBytes(before), content: after },
      { path: ".oms/history/contracts/1.json", expectedDigest: null, content: history },
    ],
  });
  return { root, target, plan };
}
function present(text: string) {
  const bytes = new TextEncoder().encode(text);
  return { state: "present" as const, bytes, signature: digestBytes(bytes) };
}
function manifest(): TemplateCompositionManifest {
  const controls = [
    { kind: "policy" as const, path: POLICY, before: "policy-v1", after: "policy-v2" },
    { kind: "taxonomy" as const, path: TAXONOMY, before: "taxonomy-v1", after: "taxonomy-v2" },
    { kind: "projection" as const, path: PROJECTION, before: "projection-v1", after: "projection-v2" },
  ];
  const mapped = controls.map(control => {
    const current = present(control.before);
    const proposed = present(control.after);
    return { kind: control.kind, path: control.path, expectedCurrent: { state: "present" as const, signature: current.signature }, current, proposed, action: "write" as const };
  }) as unknown as TemplateCompositionManifest["controls"];
  const draft: ManagedDraftTransition = {
    templateId: null,
    path: DRAFT,
    expectedCurrent: { state: "absent" },
    current: { state: "absent" },
    proposed: present("draft-v2"),
    action: "write",
  };
  const outputs = [...mapped, draft].flatMap(transition => transition.proposed.state === "present"
    ? [{ finalVaultRelativePath: transition.path, payloadDigest: transition.proposed.signature }]
    : []);
  const body = {
    version: 1 as const,
    markerPath: TEMPLATE_TRANSACTION_MARKER_PATH,
    controls: mapped,
    drafts: [draft],
    operations: [{ kind: "commit-contract" as const, templateId: null as TemplateId | null, payloadDigest: digestBytes("commit-contract") }],
    diagnostics: [],
    outputs,
  };
  return { ...body, approvalDigest: approvalDigest(body), outputDigest: outputDigest(outputs) };
}
async function transactionFixture(): Promise<string> {
  const root = await vault();
  await mkdir(join(root, ".oms"));
  await writeFile(join(root, POLICY), "policy-v1");
  await writeFile(join(root, TAXONOMY), "taxonomy-v1");
  await writeFile(join(root, PROJECTION), "projection-v1");
  return root;
}
function code(receipt: TemplateTransactionReceipt): string | undefined {
  return receipt.status === "rejected" || receipt.status === "resume-required" || receipt.status === "inconsistent" ? receipt.diagnostics[0]?.code : undefined;
}

describe("legacy publication admission", () => {
  it("keeps frozen labels as protocol evidence rather than approval or captured files", () => {
    expect(publication.classification).toBe("protocol-fixture");
    expect(publication.producerAttribution).toBe("unavailable");
    expect(publication.notCapturedTransaction).toBe(true);
    expect(publication.v3Canonical["derivation"]).toMatchObject({ classification: "synthetic-protocol-fixture", capturedVaultBytes: false, producerAttribution: "unavailable" });
    expect(publication.v4FieldOnly).toMatchObject({ classification: "verified-historical-policy-snapshot", humanApproval: false, filesystemObservation: false });
  });

  it("locates a closed marker without treating that locator as proof", () => {
    for (const name of ["v3Canonical", "v4"] as const) {
      const item = section(name);
      expect(inspectLegacyPublicationMarker(item.markerPath, item.markerBytes)).toMatchObject({ format: item.format, status: "complete", planPath: item.planPath, reasons: [] });
      expect(verifyLegacyPublicationEvidence({ ...evidence(name), observedOutputs: {} }).status).toBe("invalid");
    }
    expect(inspectLegacyPublicationMarker(".oms/other.json", section("v4").markerBytes).status).toBe("unknown");
  });

  it("derives the sealed read set and preserves the original v3 negatives", () => {
    const canonical = section("v3Canonical");
    const readSet = legacyPublicationReadSet(canonical.format, canonical.markerPath, canonical.markerBytes, canonical.planPath, canonical.planBytes);
    expect(readSet.reasons).toEqual([]);
    expect(readSet.paths).toEqual([canonical.markerPath, canonical.planPath, ...Object.keys(canonical.observed)]);
    expect(new Set(readSet.paths).size).toBe(readSet.paths.length);
    expect(verifyLegacyPublicationEvidence(evidence("v3")).status).toBe("invalid");
    expect(verifyLegacyPublicationEvidence(evidence("v3Ordered")).status).toBe("invalid");
  });

  it("observes temporary v3 nested and v4 root files without writing or authorizing publication", async () => {
    for (const name of ["v3Canonical", "v4"] as const) {
      const root = await install(name);
      const before = await tree(root);
      const admission = await inspectLegacyVaultPublication({ vault: root, source: "explicit" });
      expect(admission.status, JSON.stringify(admission)).toBe("verified");
      expect(admission.markerPath).toBe(section(name).markerPath);
      expect(JSON.stringify(admission)).not.toContain("historicalBytes");
      expect(verifiedLegacyVaultSource({ ...admission, approved: true }, "note")).toBeNull();
      expect(verifiedLegacyVaultSource(admission, "note")).toBeNull();
      await expect(planVaultPublication({ vault: root, source: "explicit" }, {
        kind: "settings-update",
        vaultId: VAULT_ID,
        outputs: [{ path: ".oms/settings.json", expectedDigest: null, content: JSON.stringify({ version: 1, vaultId: VAULT_ID, templateRoots: ["Templates"] }) }],
      })).rejects.toThrow("Historical publication marker blocks ordinary publication");
      expect(await tree(root)).toEqual(before);
    }
  });

  it("returns only the privately bound field snapshot and rejects a forged public admission", async () => {
    const root = await install("v4FieldOnly");
    const admission = await inspectLegacyVaultPublication({ vault: root, source: "explicit" });
    expect(admission.status).toBe("verified");
    const source = verifiedLegacyVaultSource(admission, "note");
    expect(source).toMatchObject({ identity: "note", path: "Templates/note.md" });
    expect(source?.historicalBytes).toEqual(new Uint8Array());
    expect(verifiedLegacyVaultSource(JSON.parse(JSON.stringify(admission)), "note")).toBeNull();
    expect(verifiedLegacyVaultSource(admission, "Templates/note.md")).toBeNull();
  });

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

  it.each([
    ["malformed", async (root: string) => { await mkdir(join(root, ".oms")); await writeFile(join(root, ".oms/template-migration.json"), "{"); }, "legacy-invalid"],
    ["multiple", async (root: string) => {
      const item = section("v3Canonical");
      await mkdir(join(root, ".oms"));
      await writeFile(join(root, item.markerPath), item.markerBytes);
      await writeFile(join(root, ".oms/template-backfill.json"), item.markerBytes);
    }, "legacy-ambiguous"],
    ["in-progress", async (root: string) => {
      const item = section("v4");
      const marker = JSON.parse(item.markerBytes) as Record<string, unknown>;
      const material = { status: "in-progress", transactionId: marker["transactionId"], approvalDigest: marker["approvalDigest"], outputDigest: marker["outputDigest"], planDigest: marker["planDigest"] };
      await mkdir(join(root, ".oms"));
      await writeFile(join(root, item.markerPath), `${canonical({ ...material, checksum: hashCanonical("oms.contract-publish.marker.v1", material) })}\n`);
    }, "legacy-in-progress"],
    ["missing-plan", async (root: string) => {
      const item = section("v4");
      await mkdir(join(root, ".oms"));
      await writeFile(join(root, item.markerPath), item.markerBytes);
    }, "legacy-unavailable"],
  ] as const)("classifies %s with zero writes", async (_name, mutate, status) => {
    const root = await vault();
    await mutate(root);
    const before = await tree(root);
    const admission = await inspectLegacyVaultPublication({ vault: root, source: "explicit" });
    expect(admission.status).toBe(status);
    expect(await tree(root)).toEqual(before);
    expect(verifiedLegacyVaultSource(admission, "note")).toBeNull();
  });

  it("blocks symlink, hardlink, nonregular, and drifted observations without mutation", async () => {
    for (const kind of ["symlink", "hardlink", "directory", "drift"] as const) {
      const root = await install("v4FieldOnly");
      const before = await tree(root);
      const output = join(root, PROJECTION);
      if (kind === "directory") {
        await rm(output);
        await mkdir(output);
      } else if (kind === "symlink") {
        await writeFile(join(root, "outside.json"), await readFile(output));
        await rm(output);
        await symlink(join(root, "outside.json"), output);
      } else if (kind === "hardlink") {
        await link(output, join(root, "outside.json"));
      } else await writeFile(output, Buffer.from("drifted"));
      const admission = await inspectLegacyVaultPublication({ vault: root, source: "explicit" });
      expect(["legacy-unavailable", "legacy-invalid"]).toContain(admission.status);
      const after = await tree(root);
      expect(Object.keys(after).filter(path => !Object.hasOwn(before, path) && path !== "outside.json")).toEqual([]);
      expect(after[POLICY]).toBe(before[POLICY]);
    }
  });

  it("returns typed admission for an unreadable legacy slot without using the write allowlist", async () => {
    const root = await vault();
    await mkdir(join(root, ".oms"));
    await symlink(join(root, "missing-target.json"), join(root, ".oms/template-migration.json"));
    const before = await tree(root);
    const admission = await inspectLegacyVaultPublication({ vault: root, source: "explicit" });
    expect(admission.status).toBe("legacy-invalid");
    expect(admission.markerPath).toBe(".oms/template-migration.json");
    expect(await tree(root)).toEqual(before);
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO before opening it", async () => {
    const root = await vault();
    await mkdir(join(root, ".oms"));
    const fifo = join(root, ".oms/template-backfill.json");
    execFileSync("mkfifo", [fifo]);
    const opened: string[] = [];
    const actualOpen = fs.promises.open;
    const spy = vi.spyOn(fs.promises, "open").mockImplementation(async (path, ...rest) => {
      opened.push(String(path));
      if (String(path) === fifo) throw new Error("FIFO must not be opened");
      return actualOpen(path, ...rest);
    });
    syncBuiltinESMExports();
    try {
      const admission = await inspectLegacyVaultPublication({ vault: root, source: "explicit" });
      expect(admission.status).toBe("legacy-invalid");
      expect(opened).not.toContain(fifo);
      expect(await tree(root)).toEqual({ ".oms/template-backfill.json": "fifo" });
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("accepts legal short reads without losing the final size probe", async () => {
    const root = await install("v4FieldOnly");
    let chunks = 0;
    const restore = observeHandles((_file, handle) => {
      const original = handle.read.bind(handle) as ChunkRead;
      handle.read = (async (...[buffer, offset, length, position]: Parameters<ChunkRead>) => {
        chunks += 1;
        return original(buffer, offset, Math.min(length, 7), position);
      }) as typeof handle.read;
    });
    try {
      expect((await inspectLegacyVaultPublication({ vault: root, source: "explicit" })).status).toBe("verified");
      expect(chunks).toBeGreaterThan(10);
    } finally { restore(); }
  });

  it.each(["replacement", "ancestor-replacement", "growth", "read-error", "close-error"] as const)("refuses %s during actual file observation", async fault => {
    const root = await install("v4FieldOnly");
    const file = join(root, POLICY);
    const originalBytes = await readFile(file);
    let fired = false;
    const restore = observeHandles((opened, handle) => {
      if (opened !== file || fired) return;
      if (fault === "close-error") {
        const original = handle.close.bind(handle);
        handle.close = async () => {
          await original();
          fired = true;
          throw Object.assign(new Error("injected close failure"), { code: "EIO" });
        };
        return;
      }
      const original = handle.read.bind(handle) as ChunkRead;
      handle.read = (async (...args: Parameters<ChunkRead>) => {
        if (fired) return original(...args);
        fired = true;
        if (fault === "read-error") throw Object.assign(new Error("injected read failure"), { code: "EIO" });
        const result = await original(...args);
        if (fault === "replacement") {
          await rm(file);
          await writeFile(file, originalBytes);
        } else if (fault === "ancestor-replacement") {
          const old = join(root, ".old-oms");
          await fs.promises.rename(join(root, ".oms"), old);
          await mkdir(join(root, ".oms"));
          for (const name of await readdir(old)) await fs.promises.rename(join(old, name), join(root, ".oms", name));
        } else await writeFile(file, Buffer.concat([originalBytes, Buffer.from("x")]));
        return result;
      }) as typeof handle.read;
    });
    try {
      expect((await inspectLegacyVaultPublication({ vault: root, source: "explicit" })).status).toBe("legacy-unavailable");
      expect(fired).toBe(true);
    } finally { restore(); }
    expect(await readFile(file)).toEqual(fault === "growth" ? Buffer.concat([originalBytes, Buffer.from("x")]) : originalBytes);
  });

  it.each(["marker BOM", "plan BOM", "invalid UTF-8"] as const)("rejects %s before evidence verification without changing bytes", async variant => {
    const root = await install("v4FieldOnly");
    const file = join(root, variant === "plan BOM" ? section("v4FieldOnly").planPath : ".oms/template-transaction.json");
    await writeFile(file, variant === "invalid UTF-8" ? Buffer.from([0xff]) : Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await readFile(file)]));
    const before = await tree(root);
    expect((await inspectLegacyVaultPublication({ vault: root, source: "explicit" })).status).toBe("legacy-invalid");
    expect(await tree(root)).toEqual(before);
  });

  it("detects a sidecar introduced after the initial marker census", async () => {
    const root = await install("v4FieldOnly");
    let planted = false;
    const restore = observeHandles((file, handle) => {
      if (file !== join(root, POLICY)) return;
      const original = handle.read.bind(handle) as ChunkRead;
      handle.read = (async (...args: Parameters<ChunkRead>) => {
        const result = await original(...args);
        if (!planted) {
          planted = true;
          await writeFile(join(root, ".oms/template-backfill.json"), "{\"late\":true}\n");
        }
        return result;
      }) as typeof handle.read;
    });
    try {
      const admission = await inspectLegacyVaultPublication({ vault: root, source: "explicit" });
      expect(planted).toBe(true);
      expect(admission.status).toBe("legacy-inconsistent");
      expect(admission.reasons.join(" ")).toContain("template-backfill.json");
    } finally { restore(); }
  });
});

describe("shared vault publication lease", () => {
  it("blocks both real writer entrypoints until the owning token releases", async () => {
    const publisher = await publicationFixture();
    const transaction = await transactionFixture();
    const publisherBefore = await tree(publisher.root);
    const transactionBefore = await tree(transaction);
    const publisherToken = await acquireTransactionLock(join(publisher.root, ".oms/.template-transactions/vault-lock"), join(publisher.root, VAULT_PUBLICATION_LEASE));
    const transactionToken = await acquireTransactionLock(join(transaction, ".oms/.template-transactions/vault-lock"), join(transaction, VAULT_PUBLICATION_LEASE));
    expect(publisherToken).toEqual(expect.any(String));
    expect(transactionToken).toEqual(expect.any(String));
    await releaseTransactionLock(join(publisher.root, VAULT_PUBLICATION_LEASE), "wrong-token");
    await releaseTransactionLock(join(transaction, VAULT_PUBLICATION_LEASE), "wrong-token");
    await expect(commitVaultPublication(publisher.target, publisher.plan, publisher.plan.planDigest)).rejects.toThrow("PUBLICATION_LOCKED");
    const approved = manifest();
    expect(code(await executeTemplateTransaction(transaction, approved, { approvedDigest: approved.approvalDigest }))).toBe("CONTRACT_TRANSACTION_IN_PROGRESS");
    expect(withoutLease(await tree(publisher.root))).toEqual(withoutLease(publisherBefore));
    expect(withoutLease(await tree(transaction))).toEqual(withoutLease(transactionBefore));
    expect(await readFile(join(publisher.root, ".oms/template-policy.json"), "utf8")).toBe(serializeContractPolicyV5(v5(0)));
    expect(await readFile(join(transaction, POLICY), "utf8")).toBe("policy-v1");

    await releaseTransactionLock(join(publisher.root, VAULT_PUBLICATION_LEASE), publisherToken!);
    await releaseTransactionLock(join(transaction, VAULT_PUBLICATION_LEASE), transactionToken!);
    const releasedPublisher = await publicationFixture();
    await expect(commitVaultPublication(releasedPublisher.target, releasedPublisher.plan, releasedPublisher.plan.planDigest)).resolves.toMatchObject({ status: "complete" });
    const releasedTransaction = await transactionFixture();
    const released = manifest();
    expect(await executeTemplateTransaction(releasedTransaction, released, { approvedDigest: released.approvalDigest })).toMatchObject({ status: "applied", markerState: "complete" });
    expect(await readFile(join(releasedTransaction, POLICY), "utf8")).toBe("policy-v2");
  });
});
