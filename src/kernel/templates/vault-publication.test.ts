import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { digestBytes, hashCanonical } from "./canonical.js";
import { serializeContractPolicyV5, type ContractPolicyV5 } from "./contract-v5.js";
import { commitVaultPublication, contractHistoryRecord, inspectVaultPublication, planVaultPublication, prepareRollbackApprovalDigest, recoverVaultPublication, type ContractHistoryKind, type VaultPublicationFault, type VaultPublicationKind, type VaultPublicationPlan } from "./vault-publication.js";

const roots: string[] = [];
const VAULT_ID = "11111111-1111-4111-8111-111111111111";
const TX_ID = "22222222-2222-4222-8222-222222222222";
const SETTINGS = JSON.stringify({ version: 1, vaultId: VAULT_ID, templateRoots: ["Templates"] });
function policy(revision: number): ContractPolicyV5 {
  return { version: 5, revision, properties: { title: { type: "text" } }, common: { status: "active", fields: { title: { required: revision > 0 } } }, templates: {} };
}
function history(kind: ContractHistoryKind, revision: number, previous: string | null, next: string) {
  return `${JSON.stringify(contractHistoryRecord({ transactionId: TX_ID, kind, revision, previousPolicyDigest: previous === null ? null : digestBytes(previous), policyDigest: digestBytes(next), decision: "approved exact policy diff" }))}\n`;
}
async function fixture(kind: VaultPublicationKind = "contract-publication", existing = true) {
  if (kind === "schema-migration") throw new Error("generic schema migration is not a publication fixture");
  const vault = await mkdtemp(join(tmpdir(), "oms-vault-publication-"));
  roots.push(vault);
  const before = serializeContractPolicyV5(policy(0));
  const after = serializeContractPolicyV5(policy(existing ? 1 : 0));
  const outputs = kind === "settings-update"
    ? [{ path: ".oms/settings.json", expectedDigest: null, content: SETTINGS }]
    : [{ path: ".oms/template-policy.json", expectedDigest: existing ? digestBytes(before) : null, content: after }, { path: `.oms/history/contracts/${existing ? 1 : 0}.json`, expectedDigest: null, content: history("publication", existing ? 1 : 0, existing ? before : null, after) }];
  if (existing || kind === "settings-update") {
    await mkdir(join(vault, ".oms"));
    if (existing) await writeFile(join(vault, ".oms/template-policy.json"), before);
  }
  const target = { vault, source: "explicit" as const };
  const plan = await planVaultPublication(target, { kind, vaultId: VAULT_ID, transactionId: TX_ID, outputs, evidence: [{ name: "legacy-policy", bytes: Buffer.from("\uFEFFlegacy evidence\r\n") }] });
  return { vault, target, plan, before, after };
}
function rootOf(plan: VaultPublicationPlan): string { return plan.kind === "schema-migration" ? "migrations" : ".template-transactions"; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("closed vault publication protocol", () => {
  it("prepares and inspects without creating control state, then publishes only policy and one history record", async () => {
    const item = await fixture("contract-publication", false);
    expect(await readdir(item.vault)).toEqual([]);
    expect((await inspectVaultPublication(item.vault)).status).toBe("absent");
    const result = await commitVaultPublication(item.target, item.plan, item.plan.planDigest);
    expect(result.verified.map(item => item.path).sort()).toEqual([".oms/history/contracts/0.json", ".oms/template-policy.json"]);
    expect(await readFile(join(item.vault, ".oms/history/contracts/0.json"), "utf8")).toContain(item.plan.transactionId);
    expect((await readdir(join(item.vault, ".oms"))).sort()).toEqual([".template-transactions", "history", "template-policy.json", "template-transaction.json"]);
    expect(await readFile(join(item.vault, `.oms/.template-transactions/${TX_ID}/plan.json`), "utf8")).not.toContain(item.vault);
    expect(await readFile(join(item.vault, `.oms/.template-transactions/${TX_ID}/complete-receipt.json`), "utf8")).toContain(item.plan.planDigest);
  });

  it.each(["Note.md", ".oms/types.json", ".obsidian/types.json", ".oms/templates/default.md", ".oms/engine-store.sqlite", ".oms/settings.json", ".oms/taxonomy.json", "../other/.oms/template-policy.json"])("rejects output %s before writing anything", async path => {
    const item = await fixture();
    await expect(planVaultPublication(item.target, { kind: "contract-publication", vaultId: VAULT_ID, transactionId: TX_ID, outputs: [{ path, expectedDigest: null, content: "{}" }] })).rejects.toThrow("allowlist");
    expect(await readdir(join(item.vault, ".oms"))).toEqual(["template-policy.json"]);
  });

  it("rejects absent, mismatched, existing and wrongly versioned history before writing", async () => {
    const item = await fixture();
    const base = { path: ".oms/template-policy.json", expectedDigest: digestBytes(item.before), content: item.after };
    await expect(planVaultPublication(item.target, { kind: "contract-publication", vaultId: VAULT_ID, transactionId: TX_ID, outputs: [base] })).rejects.toThrow("history");
    await expect(planVaultPublication(item.target, { kind: "contract-publication", vaultId: VAULT_ID, transactionId: TX_ID, outputs: [base, { path: ".oms/history/contracts/2.json", expectedDigest: null, content: history("publication", 2, item.before, item.after) }] })).rejects.toThrow("history");
    await mkdir(join(item.vault, ".oms/history/contracts"), { recursive: true });
    await writeFile(join(item.vault, ".oms/history/contracts/1.json"), "old");
    await expect(planVaultPublication(item.target, { kind: "contract-publication", vaultId: VAULT_ID, transactionId: TX_ID, history: { kind: "publication", decision: "approved" }, outputs: [base, { path: ".oms/history/contracts/1.json", expectedDigest: digestBytes("old"), content: history("publication", 1, item.before, item.after) }] })).rejects.toThrow("immutable");
    expect(await readFile(join(item.vault, ".oms/template-policy.json"), "utf8")).toBe(item.before);
  });

  it("refuses unverified targets, wrong approvals and another vault's proposal", async () => {
    const item = await fixture();
    await expect(commitVaultPublication({ ...item.target, source: "cwd" }, item.plan, item.plan.planDigest)).rejects.toThrow("PUBLICATION_TARGET_UNVERIFIED");
    await expect(commitVaultPublication(item.target, item.plan, digestBytes("wrong"))).rejects.toThrow("PUBLICATION_APPROVAL_REQUIRED");
    const other = await fixture();
    await expect(commitVaultPublication(other.target, item.plan, item.plan.planDigest)).rejects.toThrow("another vault");
    expect(await readdir(join(other.vault, ".oms"))).toEqual(["template-policy.json"]);
  });

  it("preserves byte-exact evidence without touching sources or taxonomy", async () => {
    const item = await fixture("contract-publication");
    const taxonomy = Buffer.from("\uFEFF{\"owner\":\"unchanged\"}\r\n");
    await writeFile(join(item.vault, ".oms/taxonomy.json"), taxonomy);
    await writeFile(join(item.vault, "Source.md"), "original template");
    await commitVaultPublication(item.target, item.plan, item.plan.planDigest);
    expect(await readFile(join(item.vault, `.oms/.template-transactions/${TX_ID}/evidence/legacy-policy.bin`))).toEqual(Buffer.from("\uFEFFlegacy evidence\r\n"));
    expect(await readFile(join(item.vault, ".oms/taxonomy.json"))).toEqual(taxonomy);
    expect(await readFile(join(item.vault, "Source.md"), "utf8")).toBe("original template");
    expect((await readdir(join(item.vault, ".oms"))).sort()).toEqual([".template-transactions", "history", "taxonomy.json", "template-policy.json", "template-transaction.json"]);
  });

  it("keeps settings updates in their closed namespace and rejects duplicate or corrupted plans", async () => {
    const item = await fixture();
    const settings = await planVaultPublication(item.target, { kind: "settings-update", vaultId: VAULT_ID, outputs: [{ path: ".oms/settings.json", expectedDigest: null, content: SETTINGS }] });
    expect((await commitVaultPublication(item.target, settings, settings.planDigest)).verified).toEqual([{ path: ".oms/settings.json", digest: digestBytes(SETTINGS) }]);
    await expect(planVaultPublication(item.target, { kind: "settings-update", vaultId: VAULT_ID, outputs: [{ path: ".oms/taxonomy.json", expectedDigest: null, content: "{}" }] })).rejects.toThrow("allowlist");
    await expect(planVaultPublication(item.target, { kind: "settings-update", vaultId: VAULT_ID, outputs: [{ path: ".oms/template-policy.json", expectedDigest: digestBytes(item.before), content: item.after }] })).rejects.toThrow("allowlist");
    await expect(commitVaultPublication(item.target, { ...item.plan, outputs: [...item.plan.outputs, item.plan.outputs[0]!] }, item.plan.planDigest)).rejects.toThrow("duplicated");
    await expect(commitVaultPublication(item.target, { ...item.plan, transactionId: "../../escape" }, item.plan.planDigest)).rejects.toThrow("UUID");
    await expect(commitVaultPublication(item.target, { ...item.plan, planDigest: digestBytes("bad") }, digestBytes("bad"))).rejects.toThrow("plan digest");
  });

  it("refuses malformed settings or portable identity replacement before creating publication state", async () => {
    const item = await fixture();
    const otherId = "33333333-3333-4333-8333-333333333333";
    for (const content of ["{}", JSON.stringify({ version: 1, vaultId: otherId, templateRoots: [] }), JSON.stringify({ version: 1, vaultId: VAULT_ID, templateRoots: ["/Users/owner/Templates"] })]) {
      await expect(planVaultPublication(item.target, { kind: "settings-update", vaultId: VAULT_ID, outputs: [{ path: ".oms/settings.json", expectedDigest: null, content }] })).rejects.toThrow();
    }
    const before = JSON.stringify({ version: 1, vaultId: otherId, templateRoots: [] });
    await writeFile(join(item.vault, ".oms/settings.json"), before);
    await expect(planVaultPublication(item.target, { kind: "settings-update", vaultId: VAULT_ID, outputs: [{ path: ".oms/settings.json", expectedDigest: digestBytes(before), content: SETTINGS }] })).rejects.toThrow("existing portable vault identity");
    expect((await readdir(join(item.vault, ".oms"))).sort()).toEqual(["settings.json", "template-policy.json"]);
  });
});

describe("durable boundary recovery", () => {
  it.each<VaultPublicationFault>(["after-plan", "after-backup", "after-staging", "after-marker", "after-output", "after-complete-marker", "after-receipt"])("recovers %s and retries the identical operation three times without duplicate completion", async point => {
    const item = await fixture("contract-publication");
    await expect(commitVaultPublication(item.target, item.plan, item.plan.planDigest, { fault(actual) { if (actual === point) throw new Error(`interrupted:${point}`); } })).rejects.toThrow(`interrupted:${point}`);
    for (let count = 0; count < 3; count += 1) expect((await recoverVaultPublication(item.target, item.plan.kind, TX_ID, item.plan.planDigest, "resume")).status).toBe("complete");
    expect(await readFile(join(item.vault, ".oms/template-policy.json"), "utf8")).toBe(item.after);
    expect((await readdir(join(item.vault, `.oms/.template-transactions/${TX_ID}`))).filter(file => file.endsWith("-receipt.json"))).toEqual(["complete-receipt.json"]);
  });

  it("preserves external bytes and refuses recovery until the conflict is resolved", async () => {
    const item = await fixture();
    await expect(commitVaultPublication(item.target, item.plan, item.plan.planDigest, { fault(point) { if (point === "after-marker") throw new Error("interrupt"); } })).rejects.toThrow("interrupt");
    await writeFile(join(item.vault, ".oms/template-policy.json"), "user changes");
    for (const mode of ["resume", "rollback"] as const) {
      await expect(recoverVaultPublication(item.target, item.plan.kind, TX_ID, item.plan.planDigest, mode)).rejects.toThrow("External bytes");
      expect(await readFile(join(item.vault, ".oms/template-policy.json"), "utf8")).toBe("user changes");
    }
  });

  it("rolls an in-progress publication back only while outputs are still known old or new bytes", async () => {
    const item = await fixture("contract-publication", false);
    await expect(commitVaultPublication(item.target, item.plan, item.plan.planDigest, { fault(point) { if (point === "after-output") throw new Error("interrupt"); } })).rejects.toThrow("interrupt");
    expect((await recoverVaultPublication(item.target, item.plan.kind, TX_ID, item.plan.planDigest, "rollback")).status).toBe("rolled-back");
    const files = await readdir(join(item.vault, ".oms"));
    expect(files).not.toContain("template-policy.json");
    expect(files).not.toContain("settings.json");
    expect((await inspectVaultPublication(item.vault)).status).toBe("rolled-back");
    await expect(recoverVaultPublication(item.target, item.plan.kind, TX_ID, item.plan.planDigest, "resume")).rejects.toThrow("cannot be resumed forward");
  });

  it("requires separate approval and restores every completed output, including new history, without erasing the sealed archive", async () => {
    const item = await fixture("contract-publication", false);
    await commitVaultPublication(item.target, item.plan, item.plan.planDigest);
    const forward = await readFile(join(item.vault, `.oms/.template-transactions/${TX_ID}/complete-receipt.json`));
    const staged = await readFile(join(item.vault, `.oms/.template-transactions/${TX_ID}/staged/1.bin`));
    const published = await readFile(join(item.vault, ".oms/history/contracts/0.json"));
    await expect(recoverVaultPublication(item.target, item.plan.kind, TX_ID, item.plan.planDigest, "rollback")).rejects.toThrow("separate approval");
    expect(await readFile(join(item.vault, ".oms/history/contracts/0.json"))).toEqual(published);
    const approval = prepareRollbackApprovalDigest(item.plan);
    for (let count = 0; count < 2; count += 1) expect((await recoverVaultPublication(item.target, item.plan.kind, TX_ID, item.plan.planDigest, "rollback", { rollbackApprovalDigest: approval })).status).toBe("rolled-back");
    await expect(readFile(join(item.vault, ".oms/history/contracts/0.json"))).rejects.toThrow();
    await expect(readFile(join(item.vault, ".oms/template-policy.json"))).rejects.toThrow();
    expect(await readFile(join(item.vault, `.oms/.template-transactions/${TX_ID}/complete-receipt.json`))).toEqual(forward);
    expect(await readFile(join(item.vault, `.oms/.template-transactions/${TX_ID}/staged/1.bin`))).toEqual(staged);
    expect(await readFile(join(item.vault, `.oms/.template-transactions/${TX_ID}/rolled-back-receipt.json`), "utf8")).toContain("rolled-back");
  });

  it("rechecks terminal postimages and immutable backups rather than trusting completion flags", async () => {
    const item = await fixture();
    await commitVaultPublication(item.target, item.plan, item.plan.planDigest);
    await writeFile(join(item.vault, ".oms/template-policy.json"), "outside edit");
    await expect(commitVaultPublication(item.target, item.plan, item.plan.planDigest)).rejects.toThrow("postcondition");
    await writeFile(join(item.vault, `.oms/${rootOf(item.plan)}/${TX_ID}/backups/0.bin`), "tampered");
    await expect(recoverVaultPublication(item.target, item.plan.kind, TX_ID, item.plan.planDigest, "rollback", { rollbackApprovalDigest: prepareRollbackApprovalDigest(item.plan) })).rejects.toThrow("backup");
  });

  it("does not invent a missing completion receipt after the complete marker", async () => {
    const item = await fixture();
    await commitVaultPublication(item.target, item.plan, item.plan.planDigest);
    await rm(join(item.vault, `.oms/${rootOf(item.plan)}/${TX_ID}/complete-receipt.json`));
    await expect(recoverVaultPublication(item.target, item.plan.kind, TX_ID, item.plan.planDigest, "resume")).rejects.toThrow("already sealed receipt");
  });

  it("finalizes an after-receipt crash without replaying restored preimages", async () => {
    const item = await fixture("contract-publication", false);
    await expect(commitVaultPublication(item.target, item.plan, item.plan.planDigest, { fault(point) { if (point === "after-receipt") throw new Error("interrupted:after-receipt"); } })).rejects.toThrow("interrupted:after-receipt");
    const root = join(item.vault, `.oms/.template-transactions/${TX_ID}`);
    const receipt = await readFile(join(root, "complete-receipt.json"));
    const marker = await readFile(join(item.vault, ".oms/template-transaction.json"));
    const staged = await readFile(join(root, "staged/1.bin"));
    const restored = new Map<string, Buffer | null>();
    for (const output of item.plan.outputs) {
      const path = join(item.vault, output.path);
      restored.set(path, output.before === null ? null : Buffer.from(output.before.base64, "base64"));
      if (output.before === null) await rm(path);
      else await writeFile(path, Buffer.from(output.before.base64, "base64"));
    }
    for (let count = 0; count < 3; count += 1) await expect(recoverVaultPublication(item.target, item.plan.kind, TX_ID, item.plan.planDigest, "resume")).rejects.toThrow("postimages");
    for (const [path, bytes] of restored) {
      if (bytes === null) await expect(readFile(path)).rejects.toThrow();
      else expect(await readFile(path)).toEqual(bytes);
    }
    expect(await readFile(join(root, "complete-receipt.json"))).toEqual(receipt);
    expect(await readFile(join(item.vault, ".oms/template-transaction.json"))).toEqual(marker);
    expect(await readFile(join(root, "staged/1.bin"))).toEqual(staged);
    expect((await readdir(root)).filter(file => file.endsWith("-receipt.json"))).toEqual(["complete-receipt.json"]);
    await expect(recoverVaultPublication(item.target, item.plan.kind, TX_ID, item.plan.planDigest, "rollback")).rejects.toThrow("separate approval");
    for (const [path, bytes] of restored) {
      if (bytes === null) await expect(readFile(path)).rejects.toThrow();
      else expect(await readFile(path)).toEqual(bytes);
    }
    const approval = prepareRollbackApprovalDigest(item.plan);
    for (let count = 0; count < 2; count += 1) expect((await recoverVaultPublication(item.target, item.plan.kind, TX_ID, item.plan.planDigest, "rollback", { rollbackApprovalDigest: approval })).status).toBe("rolled-back");
    expect(await readFile(join(root, "complete-receipt.json"))).toEqual(receipt);
    expect(await readFile(join(root, "rolled-back-receipt.json"), "utf8")).toContain("rolled-back");
    await expect(readFile(join(item.vault, ".oms/template-policy.json"))).rejects.toThrow();
    await expect(readFile(join(item.vault, ".oms/history/contracts/0.json"))).rejects.toThrow();
  });

  it("rejects a forged or missing receipt instead of inventing completion from the marker", async () => {
    const item = await fixture("contract-publication");
    await expect(commitVaultPublication(item.target, item.plan, item.plan.planDigest, { fault(point) { if (point === "after-receipt") throw new Error("interrupted:after-receipt"); } })).rejects.toThrow("interrupted:after-receipt");
    const receiptPath = join(item.vault, `.oms/.template-transactions/${TX_ID}/complete-receipt.json`);
    const receipt = await readFile(receiptPath);
    const published = await readFile(join(item.vault, ".oms/template-policy.json"));
    await writeFile(receiptPath, Buffer.from(receipt.subarray(0, receipt.length - 2)));
    await expect(recoverVaultPublication(item.target, item.plan.kind, TX_ID, item.plan.planDigest, "resume")).rejects.toThrow("does not match the sealed publication plan");
    expect(await readFile(join(item.vault, ".oms/template-policy.json"))).toEqual(published);
    await rm(receiptPath);
    await expect(recoverVaultPublication(item.target, item.plan.kind, TX_ID, item.plan.planDigest, "resume")).resolves.toMatchObject({ status: "complete" });
    expect(await readFile(receiptPath)).toEqual(receipt);
  });

  it("refuses forward resume once rollback owns the marker", async () => {
    for (const status of ["rolling-back", "rolled-back"] as const) {
      const item = await fixture("contract-publication");
      await commitVaultPublication(item.target, item.plan, item.plan.planDigest);
      const markerPath = join(item.vault, ".oms/template-transaction.json");
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as { version: "oms.vault-publication.v1"; transactionId: string; kind: VaultPublicationKind; planDigest: string; status: string };
      const value = { version: marker.version, transactionId: marker.transactionId, kind: marker.kind, planDigest: marker.planDigest, status };
      await writeFile(markerPath, `${JSON.stringify({ ...value, checksum: hashCanonical("oms.vault-publication.marker.v1", value) })}\n`);
      const published = await readFile(join(item.vault, ".oms/template-policy.json"));
      const receipt = await readFile(join(item.vault, `.oms/.template-transactions/${TX_ID}/complete-receipt.json`));
      await expect(recoverVaultPublication(item.target, item.plan.kind, TX_ID, item.plan.planDigest, "resume")).rejects.toThrow("cannot be resumed forward");
      expect(await readFile(join(item.vault, ".oms/template-policy.json"))).toEqual(published);
      expect(await readFile(join(item.vault, `.oms/.template-transactions/${TX_ID}/complete-receipt.json`))).toEqual(receipt);
      expect(JSON.parse(await readFile(markerPath, "utf8")).status).toBe(status);
    }
  });

  it("does not rewrite an already terminal marker on repeated completion", async () => {
    const item = await fixture();
    await commitVaultPublication(item.target, item.plan, item.plan.planDigest);
    const markerPath = join(item.vault, ".oms/template-transaction.json");
    const before = await lstat(markerPath);
    const bytes = await readFile(markerPath);
    await recoverVaultPublication(item.target, item.plan.kind, TX_ID, item.plan.planDigest, "resume");
    const after = await lstat(markerPath);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(await readFile(markerPath)).toEqual(bytes);
  });

  it("rejects rollback from a complete marker whose completion receipt is missing", async () => {
    const item = await fixture();
    await commitVaultPublication(item.target, item.plan, item.plan.planDigest);
    await rm(join(item.vault, `.oms/${rootOf(item.plan)}/${TX_ID}/complete-receipt.json`));
    const published = await readFile(join(item.vault, ".oms/template-policy.json"));
    await expect(recoverVaultPublication(item.target, item.plan.kind, TX_ID, item.plan.planDigest, "rollback", { rollbackApprovalDigest: prepareRollbackApprovalDigest(item.plan) })).rejects.toThrow("already sealed receipt");
    expect(await readFile(join(item.vault, ".oms/template-policy.json"))).toEqual(published);
  });

  it("detects source drift before staging and leaves source files untouched", async () => {
    const item = await fixture();
    await writeFile(join(item.vault, "Source.md"), "approved source");
    const plan = await planVaultPublication(item.target, { kind: "contract-publication", vaultId: VAULT_ID, transactionId: TX_ID, history: { kind: "publication", decision: "publish reviewed contract rules" }, outputs: [{ path: ".oms/template-policy.json", expectedDigest: digestBytes(item.before), content: item.after }], sources: [{ path: "Source.md", digest: digestBytes("approved source") }] });
    await writeFile(join(item.vault, "Source.md"), "changed source");
    await expect(commitVaultPublication(item.target, plan, plan.planDigest)).rejects.toThrow("Source changed");
    expect(await readFile(join(item.vault, "Source.md"), "utf8")).toBe("changed source");
  });

  it("rejects symbolic or hard-linked control targets without changing the referenced file", async () => {
    for (const kind of ["symlink", "hardlink"]) {
      const item = await fixture();
      const original = join(item.vault, ".oms/template-policy.json");
      await rm(original);
      const external = join(item.vault, "keep.json");
      await writeFile(external, item.before);
      if (kind === "symlink") await symlink(external, original);
      else await link(external, original);
      await expect(commitVaultPublication(item.target, item.plan, item.plan.planDigest)).rejects.toThrow();
      expect(await readFile(external, "utf8")).toBe(item.before);
    }
  });

  it("serializes different transaction kinds with one shared vault lock", async () => {
    const item = await fixture();
    const second = await planVaultPublication(item.target, { kind: "settings-update", vaultId: VAULT_ID, outputs: [{ path: ".oms/settings.json", expectedDigest: null, content: SETTINGS }] });
    let resume!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { resume = resolve; });
    const first = commitVaultPublication(item.target, item.plan, item.plan.planDigest, { async fault(point) { if (point === "after-plan") { entered(); await wait; } } });
    await enteredPromise;
    try { await expect(commitVaultPublication(item.target, second, second.planDigest)).rejects.toThrow("PUBLICATION_LOCKED"); }
    finally { resume(); }
    await first;
    await expect(commitVaultPublication(item.target, second, second.planDigest)).rejects.toThrow("Marker changed");
  });
});

describe("legacy policy admission without claiming equivalence", () => {
  it.each([3, 4])("rejects an explicit opaque v%s policy instead of publishing it as proved migration", async version => {
    const vault = await mkdtemp(join(tmpdir(), "oms-vault-publication-"));
    roots.push(vault);
    await mkdir(join(vault, ".oms"));
    const before = Buffer.from(`\uFEFF{"version":${version},"templates":{"note":{"source":"Templates/note.md"}}}\r\n`);
    await writeFile(join(vault, ".oms/template-policy.json"), before);
    const after = serializeContractPolicyV5(policy(0));
    await expect(planVaultPublication({ vault, source: "explicit" }, {
      kind: "schema-migration", vaultId: VAULT_ID, transactionId: TX_ID,
      history: { kind: "migration", decision: "approved explicit migration; legacy semantics are not proven equivalent" },
      outputs: [{ path: ".oms/template-policy.json", expectedDigest: digestBytes(before), content: after }],
    })).rejects.toThrow("dedicated private-admission planner");
    expect(await readFile(join(vault, ".oms/template-policy.json"))).toEqual(before);
    expect(await readdir(join(vault, ".oms"))).toEqual(["template-policy.json"]);
  });

  it("rejects caller-built schema migration before history closure can authorize it", async () => {
    const item = await fixture();
    const base = { path: ".oms/template-policy.json", expectedDigest: digestBytes(item.before), content: item.after };
    const one = { path: ".oms/history/contracts/1.json", expectedDigest: null, content: history("migration", 1, item.before, item.after) };
    const two = { path: ".oms/history/contracts/9.json", expectedDigest: null, content: history("publication", 9, item.before, item.after) };
    await expect(planVaultPublication(item.target, { kind: "schema-migration", vaultId: VAULT_ID, transactionId: TX_ID, outputs: [base, one, two] })).rejects.toThrow("dedicated private-admission planner");
    await expect(planVaultPublication(item.target, { kind: "schema-migration", vaultId: VAULT_ID, transactionId: TX_ID, outputs: [base, one] })).rejects.toThrow("dedicated private-admission planner");
    expect(await readdir(join(item.vault, ".oms"))).toEqual(["template-policy.json"]);
  });

  it("rejects generic planning over a non-current marker without creating migration state", async () => {
    const item = await fixture();
    for (const marker of [JSON.stringify({ status: "complete" }), JSON.stringify({ version: "oms.vault-publication.v1", status: "complete", checksum: false })]) {
      await writeFile(join(item.vault, ".oms/template-transaction.json"), marker);
      await expect(planVaultPublication(item.target, { kind: "schema-migration", vaultId: VAULT_ID, transactionId: TX_ID, outputs: item.plan.outputs.map(output => ({ path: output.path, expectedDigest: output.before?.digest ?? null, content: Buffer.from(output.after.base64, "base64").toString("utf8") })) })).rejects.toThrow("dedicated private-admission planner");
      expect(await readFile(join(item.vault, ".oms/template-policy.json"), "utf8")).toBe(item.before);
      expect(await readdir(join(item.vault, ".oms"))).toEqual(["template-policy.json", "template-transaction.json"]);
    }
  });
});
