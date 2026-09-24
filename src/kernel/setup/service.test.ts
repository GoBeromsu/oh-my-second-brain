import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { v3Bundle, v4Bundle } from "../../../test/fixtures/legacy-publication-builders.js";
import { digestBytes, hashCanonical } from "../templates/canonical.js";
import { serializeContractPolicyV5, type ContractPolicyV5 } from "../templates/contract-v5.js";
import { serializeVaultSettings } from "../templates/vault-settings.js";
import {
  commitVaultPublication,
  contractHistoryRecord,
  executeLegacyVaultEquivalence,
  inspectLegacyVaultPublication,
  planLegacyVaultMigration,
  planVaultPublication,
  prepareRollbackApprovalDigest,
  recoverVaultPublication,
  type VaultPublicationPlan,
} from "../templates/vault-publication.js";
import { inspectFreshSetup, prepareFreshSetup, type FreshSetupIdentity } from "./service.js";

const roots: string[] = [];
const VAULT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const TX_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const encoder = new TextEncoder();

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function vault(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "oms-fresh-setup-"));
  const root = await realpath(created);
  roots.push(root);
  return root;
}

async function writeTree(root: string, files: Readonly<Record<string, string | Uint8Array>>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(join(root, dirname(relative)), { recursive: true });
    await writeFile(join(root, relative), content);
  }
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relative = absolute.slice(root.length + 1);
      if (entry.isDirectory()) await walk(absolute);
      else found[relative] = digestBytes(await readFile(absolute));
    }
  };
  await walk(root);
  return found;
}

function policy(revision = 1, commonStatus: "active" | "review-required" = "active"): ContractPolicyV5 {
  return {
    version: 5,
    revision,
    properties: { title: { type: "text" } },
    common: commonStatus === "active"
      ? { status: "active", fields: { title: { required: true } } }
      : { status: "review-required", reasons: ["manual review"], legacy: { version: 4 } },
    templates: {},
  };
}

function settings(vaultId = VAULT_ID): string {
  return serializeVaultSettings({ version: 1, vaultId, templateRoots: [] });
}

function settingsRoot(transactionId = TX_ID, vaultId = VAULT_ID): FreshSetupIdentity {
  return { kind: "settings-root", operationId: OPERATION_ID, transactionId, vaultId };
}

function verifiedTarget(): FreshSetupIdentity {
  return { kind: "verified-target", operationId: OPERATION_ID };
}

async function published(kind: "contract-publication" | "settings-update" = "contract-publication"): Promise<{ readonly root: string; readonly plan: VaultPublicationPlan }> {
  const root = await vault();
  const content = serializeContractPolicyV5(policy(0));
  const target = { vault: root, source: "explicit" as const };
  const plan = await planVaultPublication(target, {
    kind,
    vaultId: VAULT_ID,
    transactionId: TX_ID,
    outputs: kind === "settings-update"
      ? [{ path: ".oms/settings.json", expectedDigest: null, content: settings() }]
      : [{ path: ".oms/template-policy.json", expectedDigest: null, content }, { path: ".oms/history/contracts/0.json", expectedDigest: null, content: `${JSON.stringify(contractHistoryRecord({ transactionId: TX_ID, kind: "publication", revision: 0, previousPolicyDigest: null, policyDigest: digestBytes(content), decision: "approved exact policy" }))}\n` }],
  });
  await commitVaultPublication(target, plan, plan.planDigest);
  return { root, plan };
}

describe("fresh setup inspection", () => {
  it("reports raw folder hints and creates nothing", async () => {
    const root = await vault();
    const source = "---\ntitle: <%* throw new Error(\"executed\") %>\n---\n";
    await writeTree(root, { "Templates/note.md": source, ".obsidian/templates.json": JSON.stringify({ folder: "Templates" }), "notes/one.md": "Existing note.\n" });
    const before = await snapshot(root);
    const inspected = await inspectFreshSetup({ vault: root });
    expect(inspected.state).toBe("contract-setup-required");
    expect(inspected.settings).toEqual({ state: "missing" });
    expect(inspected.hints.candidates.map(candidate => candidate.path)).toContain("Templates");
    expect(inspected.document).not.toHaveProperty("policy");
    expect(inspected.document.templateFolderHints.map(hint => hint.path)).toContain("Templates");
    expect(await readFile(join(root, "Templates/note.md"), "utf8")).toBe(source);
    expect(await snapshot(root)).toEqual(before);
  });

  it("keeps absent and malformed settings distinct from a valid identity", async () => {
    const absent = await vault();
    await writeTree(absent, { ".oms/template-policy.json": serializeContractPolicyV5(policy()) });
    expect((await inspectFreshSetup({ vault: absent })).settings).toEqual({ state: "missing" });

    const valid = await vault();
    await writeTree(valid, { ".oms/settings.json": settings(), ".oms/models.json": "{\"version\":1}\n" });
    const verified = await inspectFreshSetup({ vault: valid });
    expect(verified.settings).toEqual({ state: "verified", vaultId: VAULT_ID });
    expect(verified.state).toBe("contract-setup-required");

    const malformed = await vault();
    await writeTree(malformed, { ".oms/settings.json": "{\"version\":1,\"vaultId\":\"not-a-uuid\",\"templateRoots\":[]}\n" });
    const blocked = await inspectFreshSetup({ vault: malformed });
    expect(blocked.state).toBe("blocked");
    expect(blocked.settings.state).toBe("missing");
    expect(blocked.diagnostics[0]?.path).toBe(".oms/settings.json");
  });

  it("recognizes actual V5 with or without a marker and without settings", async () => {
    const manual = await vault();
    const text = serializeContractPolicyV5(policy(4));
    await writeTree(manual, { ".oms/template-policy.json": text });
    const configured = await inspectFreshSetup({ vault: manual });
    expect(configured.state).toBe("contract-configured");
    expect(configured.document.policy).toEqual({ version: 5, revision: 4, commonStatus: "active" });
    expect(configured.settings).toEqual({ state: "missing" });
    expect(await readdir(join(manual, ".oms"))).toEqual(["template-policy.json"]);

    const native = await published();
    const marked = await inspectFreshSetup({ vault: native.root });
    expect(marked.state).toBe("contract-configured");
    expect(marked.document.policy).toEqual({ version: 5, revision: 0, commonStatus: "active" });
    expect(marked.document).not.toHaveProperty("migrationRetryAnchor");
  });
  it("names the actual next action without inventing identity, selection, or defaults", async () => {
    const absent = await vault();
    await writeTree(absent, { ".oms/template-policy.json": serializeContractPolicyV5(policy(2)) });
    expect((await inspectFreshSetup({ vault: absent })).document.nextStep).toBe("identity-setup-required");

    const review = await vault();
    await writeTree(review, { ".oms/template-policy.json": serializeContractPolicyV5(policy(3, "review-required")), ".oms/settings.json": settings() });
    const held = await inspectFreshSetup({ vault: review });
    expect(held.state).toBe("contract-configured");
    expect(held.document.policy).toEqual({ version: 5, revision: 3, commonStatus: "review-required" });
    expect(held.document.nextStep).toBe("review-contract");
    expect(held.document).not.toHaveProperty("activePolicy");

    const ready = await vault();
    await writeTree(ready, { ".oms/template-policy.json": serializeContractPolicyV5(policy(5)), ".oms/settings.json": settings() });
    const selected = await inspectFreshSetup({ vault: ready });
    expect(selected.document.nextStep).toBe("select-contract");
    expect(selected.settings).toEqual({ state: "verified", vaultId: VAULT_ID });

    const empty = await vault();
    expect((await inspectFreshSetup({ vault: empty })).document.nextStep).toBe("configure-contract");
  });
  it("blocks duplicate JSON and invalid UTF-8 policy without rewriting it", async () => {
    const duplicate = await vault();
    await writeTree(duplicate, { ".oms/template-policy.json": "{\"version\":5,\"version\":5}\n" });
    const before = await readFile(join(duplicate, ".oms/template-policy.json"));
    expect((await inspectFreshSetup({ vault: duplicate })).diagnostics[0]?.code).toBe("policy-duplicate-json");
    expect(await readFile(join(duplicate, ".oms/template-policy.json"))).toEqual(before);

    const invalid = await vault();
    await writeTree(invalid, { ".oms/template-policy.json": Buffer.from([0xff, 0xfe, 0xfd]) });
    expect((await inspectFreshSetup({ vault: invalid })).diagnostics[0]?.code).toBe("policy-invalid-utf8");
  });

  it("holds verified and in-progress legacy markers and blocks a drifted historical publication unchanged", async () => {
    const bundle = v4Bundle();
    const verified = await vault();
    await writeTree(verified, { [bundle.markerPath]: bundle.markerBytes, [bundle.planPath]: bundle.planBytes, ...bundle.observed });
    const before = await snapshot(verified);
    const held = await inspectFreshSetup({ vault: verified });
    expect(held.state).toBe("held-legacy");
    expect(held.diagnostics[0]?.code).toBe("verified");
    expect(await snapshot(verified)).toEqual(before);

    const inconsistent = await vault();
    await writeTree(inconsistent, { [bundle.markerPath]: bundle.markerBytes, [bundle.planPath]: bundle.planBytes, ...bundle.observed, ".oms/template-policy.json": encoder.encode("drifted") });
    const beforeInconsistent = await snapshot(inconsistent);
    const drifted = await inspectFreshSetup({ vault: inconsistent });
    expect(drifted.state).toBe("blocked");
    expect(drifted.diagnostics[0]?.code).toBe("legacy-invalid");
    expect(drifted.diagnostics[0]?.message).toBe("v4 observed postimage is missing or mismatched");
    expect(await snapshot(inconsistent)).toEqual(beforeInconsistent);

    const progressing = await vault();
    const markerText = new TextDecoder().decode(bundle.markerBytes);
    const marker = JSON.parse(markerText) as { transactionId: string; approvalDigest: string; outputDigest: string; planDigest: string; checksum: string };
    const inProgressBytes = markerText
      .replace('"status":"complete"', '"status":"in-progress"')
      .replace(marker.checksum, hashCanonical("oms.contract-publish.marker.v1", { status: "in-progress", transactionId: marker.transactionId, approvalDigest: marker.approvalDigest, outputDigest: marker.outputDigest, planDigest: marker.planDigest }));
    expect(inProgressBytes).not.toBe(markerText);
    await writeTree(progressing, { [bundle.markerPath]: encoder.encode(inProgressBytes), [bundle.planPath]: bundle.planBytes, ...bundle.observed });
    const legacy = await inspectFreshSetup({ vault: progressing });
    expect(legacy.state).toBe("held-legacy");
    expect(legacy.diagnostics[0]?.code).toBe("legacy-in-progress");
  });

  it("blocks native in-progress and rolling-back markers and retains a rolled-back migration anchor", async () => {
    for (const status of ["in-progress", "rolling-back"] as const) {
      const native = await published();
      const markerPath = join(native.root, ".oms/template-transaction.json");
      const original = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
      const { checksum: _checksum, ...unsigned } = { ...original, status };
      const before = await snapshot(native.root);
      await writeFile(markerPath, `${JSON.stringify({ ...unsigned, checksum: hashCanonical("oms.vault-publication.marker.v1", unsigned) })}\n`);
      const blocked = await inspectFreshSetup({ vault: native.root });
      expect(blocked.state).toBe("blocked");
      expect(blocked.diagnostics.map(issue => issue.code)).toContain(status);
      const after = await snapshot(native.root);
      expect(after[".oms/template-policy.json"]).toBe(before[".oms/template-policy.json"]);
      expect(after[".oms/template-transaction.json"]).not.toBe(before[".oms/template-transaction.json"]);
      await writeFile(join(native.root, ".oms/settings.json"), "{\"version\":5,\"version\":5}\n");
      await writeFile(join(native.root, ".oms/template-policy.json"), Buffer.from([0xff, 0xfe]));
      const obscured = await snapshot(native.root);
      const pending = await inspectFreshSetup({ vault: native.root });
      expect(pending.state).toBe("blocked");
      expect(pending.diagnostics.map(issue => issue.code)).toEqual([status]);
      expect(pending.document.nextStep).toBe("resolve-blocker");
      expect(await snapshot(native.root)).toEqual(obscured);
    }

    const bundle = v3Bundle();
    const root = await vault();
    await writeTree(root, { [bundle.markerPath]: bundle.markerBytes, [bundle.planPath]: bundle.planBytes, ...bundle.observed });
    const target = { vault: root, source: "explicit" as const };
    const admission = await inspectLegacyVaultPublication(target);
    const proof = executeLegacyVaultEquivalence(admission);
    if (proof?.disposition !== "proved") throw new Error(proof?.reasons.join("; ") ?? "synthetic historical proof missing");
    const plan = await planLegacyVaultMigration(target, admission, proof.proof, { vaultId: VAULT_ID, transactionId: TX_ID });
    await expect(commitVaultPublication(target, plan, plan.planDigest, { fault(point) { if (point === "after-marker") throw new Error("after-marker"); } })).rejects.toThrow("after-marker");
    await recoverVaultPublication(target, "schema-migration", TX_ID, plan.planDigest, "rollback", { rollbackApprovalDigest: prepareRollbackApprovalDigest(plan) });
    const before = await snapshot(root);
    const retry = await inspectFreshSetup({ vault: root });
    expect(retry.state).toBe("held-legacy");
    expect(retry.document.migrationRetryAnchor).toEqual({ kind: "schema-migration", status: "rolled-back", transactionId: TX_ID, planDigest: plan.planDigest });
    expect(await snapshot(root)).toEqual(before);
  });
});

describe("fresh setup preparation", () => {
  it("blocks an unsupported target source before preparation", async () => {
    const root = await vault();
    const prepared = await prepareFreshSetup({ target: { vault: root, source: "cwd" }, identity: settingsRoot() });
    expect(prepared.state).toBe("blocked");
    expect(prepared.diagnostics[0]?.code).toBe("target-unverified");
    expect(await readdir(root)).toEqual([]);
  });

  it("fails a mode mismatch instead of switching identity", async () => {
    const configured = await vault();
    await writeTree(configured, { ".oms/settings.json": settings() });
    await expect(prepareFreshSetup({ target: { vault: configured, source: "explicit" }, identity: settingsRoot() })).resolves.toMatchObject({ state: "blocked", diagnostics: [{ code: "identity-conflict" }] });
    const absent = await vault();
    await expect(prepareFreshSetup({ target: { vault: absent, source: "explicit" }, identity: verifiedTarget() })).resolves.toMatchObject({ state: "blocked", diagnostics: [{ code: "identity-missing" }] });
  });

  it("rejects an explicit UUID mismatch and stale coordinator controls", async () => {
    const root = await vault();
    await expect(prepareFreshSetup({ target: { vault: root, source: "explicit" }, identity: { kind: "settings-root", operationId: "not-a-uuid", transactionId: TX_ID, vaultId: VAULT_ID } })).rejects.toThrow("operationId");
    await expect(prepareFreshSetup({ target: { vault: root, source: "explicit" }, identity: { kind: "settings-root", operationId: OPERATION_ID, transactionId: TX_ID, vaultId: OTHER_ID, extra: true } })).rejects.toThrow("settings-root identity must contain");
    const inside = await prepareFreshSetup({ target: { vault: root, source: "explicit" }, identity: settingsRoot(), coordinatorOptions: { registryPath: root } });
    expect(inside.state).toBe("blocked");
    expect(inside.diagnostics).toEqual([expect.objectContaining({ code: "unsafe-target", message: expect.stringContaining("must be a regular file") })]);
    expect(await readdir(root)).toEqual([]);
    const created = await mkdtemp(join(tmpdir(), "oms-fresh-registry-"));
    const outside = await realpath(created);
    roots.push(outside);
    const registry = join(outside, "connections.json");
    const staleBytes = "{not-json\n";
    await writeFile(registry, staleBytes);
    const stale = await vault();
    const before = await snapshot(stale);
    const drifted = await prepareFreshSetup({ target: { vault: stale, source: "explicit" }, identity: settingsRoot(), coordinatorOptions: { registryPath: registry } });
    expect(drifted.state).toBe("blocked");
    expect(drifted.diagnostics).toEqual([expect.objectContaining({ code: "registry-blocked", message: expect.stringContaining("malformed") })]);
    expect(await readFile(registry, "utf8")).toBe(staleBytes);
    expect(await snapshot(stale)).toEqual(before);
  });

  it("prepares settings-only or null publication with select false and no project", async () => {
    const fresh = await vault();
    const before = await snapshot(fresh);
    const settingsOnly = await prepareFreshSetup({ target: { vault: fresh, source: "explicit" }, identity: settingsRoot() });
    if (settingsOnly.state !== "ready") throw new Error(settingsOnly.diagnostics.map(issue => issue.message).join("; "));
    expect(settingsOnly.connection.input.publication).toMatchObject({ kind: "settings-update", transactionId: TX_ID, vaultId: VAULT_ID });
    expect(settingsOnly.connection.input.select).toBe(false);
    expect(settingsOnly.connection.input.project).toBeUndefined();
    expect(settingsOnly.connection.input.target.source).toBe("explicit");
    expect(await snapshot(fresh)).toEqual(before);

    const manual = await vault();
    await writeTree(manual, { ".oms/template-policy.json": serializeContractPolicyV5(policy()), ".oms/settings.json": settings() });
    const verified = await prepareFreshSetup({ target: { vault: manual, source: "explicit" }, identity: verifiedTarget() });
    if (verified.state !== "ready") throw new Error(verified.diagnostics.map(issue => issue.message).join("; "));
    expect(verified.connection.input.publication).toBeNull();
    expect(verified.connection.input.select).toBe(false);
    expect(verified.connection.input.project).toBeUndefined();
    expect(verified.inspection.document.policy).toEqual({ version: 5, revision: 1, commonStatus: "active" });
  });
});
