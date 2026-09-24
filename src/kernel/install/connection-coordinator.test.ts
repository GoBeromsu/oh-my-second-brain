import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { digestBytes } from "../templates/canonical.js";
import { serializeVaultSettings } from "../templates/vault-settings.js";
import { prepareLegacyVaultMigration, type PreparedLegacyMigration } from "../templates/vault-publication.js";
import type { LegacyEquivalenceCandidate } from "../templates/legacy-equivalence.js";
import { v3Bundle, v4Bundle, v4Policy, type HistoricalBundle } from "../../../test/fixtures/legacy-publication-builders.js";
import {
  commitConnection,
  commitMigratedConnection,
  prepareMigratedConnection,
  resumeMigratedConnection,
  hasConnectionIntent,
  type PreparedMigratedConnection,
  ConnectionCoordinatorError,
  prepareConnection,
  settingsPublicationRequest,
  type ConnectionCommitResult,
  type ConnectionCoordinatorFault,
  type PreparedConnection,
} from "./connection-coordinator.js";
import { connectionDigest, connectionRegistryPath, readConnectionRegistry, upsertVaultConnection } from "./connection-registry.js";
import { readProjectConnection } from "./project-connection.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";
const OP = "44444444-4444-4444-8444-444444444444";
const TX = "55555555-5555-4555-8555-555555555555";
const FORBIDDEN_INTENT_KEYS = ["publicationPlan", "progress", "templateRoots", "source", "evidence", "base64"] as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ readonly root: string; readonly vaultA: string; readonly vaultB: string; readonly project: string; readonly registry: string; readonly runtime: string }> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "oms-connection-coordinator-")));
  roots.push(root);
  const vaultA = path.join(root, "vault-a");
  const vaultB = path.join(root, "vault-b");
  const project = path.join(root, "project");
  await Promise.all([mkdir(vaultA), mkdir(vaultB), mkdir(project)]);
  return { root, vaultA, vaultB, project, registry: connectionRegistryPath({ XDG_CONFIG_HOME: path.join(root, "xdg") }, root), runtime: path.join(root, "runtime") };
}

function options(registry: string, runtime: string, fault?: ConnectionCoordinatorFault | "after-plan", home?: string) {
  const publicationFault = fault === "after-plan" ? () => { throw new ConnectionCoordinatorError("injected-fault", "Injected native fault at after-plan."); } : undefined;
  return { registryPath: registry, runtimeRoot: runtime, createId: () => ID_A, ...(home === undefined ? {} : { homeDir: home, env: { HOME: home, XDG_CONFIG_HOME: path.dirname(path.dirname(registry)) } }), ...(fault !== undefined && fault !== "after-plan" ? { coordinatorFault: fault } : {}), ...(publicationFault === undefined ? {} : { publicationFault }) };
}

async function publish(vault: string, vaultId: string): Promise<void> {
  await mkdir(path.join(vault, ".oms"), { recursive: true });
  await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId, templateRoots: [] }));
}

async function pointer(registry: string, vault: string): Promise<string> {
  await mkdir(path.dirname(registry), { recursive: true });
  const signature = createHash("sha256").update(`oms-host-vault-pointer\n1\n${vault}\n`).digest("hex");
  const raw = `${JSON.stringify({ version: 1, vault, signature })}\n`;
  await writeFile(registry, raw);
  return digestBytes(raw);
}

function intentFile(runtime: string, operationId = OP): string {
  return path.join(runtime, "connection-coordinator", "v1", operationId, "intent.json");
}

function reservationFile(runtime: string, canonical: string, portableVaultId: string): string {
  const key = createHash("sha256").update(`${canonical}\0${portableVaultId}`).digest("hex");
  return path.join(runtime, "connection-reservations", "v1", `${key}.json`);
}

function registryReceiptFile(runtime: string, operationId = OP): string {
  return path.join(runtime, "connection-updates", "v1", operationId, "receipt.json");
}

function projectReceiptFile(runtime: string, operationId = OP): string {
  return path.join(runtime, "connection-updates", "v1", operationId, "project-receipt.json");
}

async function bytesAt(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function privateMode(file: string): Promise<number> {
  return (await lstat(file)).mode & 0o077;
}

async function prepareFull(vault: string, project: string, registry: string, runtime: string, scope: readonly string[] = ["notes"], operationId = OP, transactionId = TX, vaultId = ID_A): Promise<PreparedConnection> {
  return prepareConnection({
    operationId,
    target: { vault, source: "explicit" },
    publication: settingsPublicationRequest(transactionId, vaultId),
    select: false,
    project: { root: project, scope },
  }, options(registry, runtime));
}

async function nativeSnapshot(vault: string, project: string, registry: string, runtime: string, operationId = OP) {
  return {
    settings: await bytesAt(path.join(vault, ".oms", "settings.json")),
    marker: await bytesAt(path.join(vault, ".oms", "template-transaction.json")),
    reservation: await bytesAt(reservationFile(runtime, vault, ID_A)),
    registryReceipt: await bytesAt(registryReceiptFile(runtime, operationId)),
    projectReceipt: await bytesAt(projectReceiptFile(runtime, operationId)),
    registry: await bytesAt(registry),
    links: await bytesAt(path.join(project, ".oms", "links.yaml")),
    intent: await bytesAt(intentFile(runtime, operationId)),
  };
}

function assertIntentContent(raw: string, prepared: PreparedConnection): void {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  expect(parsed["protocol"]).toBe("oms.connection-coordinator.v1");
  expect(parsed["operationId"]).toBe(prepared.operationId);
  expect(parsed["planDigest"]).toBe(prepared.digest);
  expect(parsed["canonicalTarget"]).toBe(prepared.canonicalTarget);
  expect(parsed["registryPath"]).toBe(prepared.registryPath);
  expect(parsed["runtimeRoot"]).toBe(prepared.runtimeRoot);
  expect(parsed["publicationTransactionId"]).toBe(prepared.publicationPlan?.transactionId);
  expect(parsed["publicationPlanDigest"]).toBe(prepared.publicationPlan?.planDigest);
  expect(parsed["portableVaultId"]).toBe(prepared.portableVaultId);
  expect(parsed["expectedRegistryDigest"]).toBe(prepared.expectedRegistryDigest);
  expect(parsed["expectedProjectDigest"]).toBe(prepared.expectedProjectDigest);
  expect(parsed["projectRoot"]).toBe(prepared.input.project?.root ?? null);
  expect(parsed["projectPath"]).toBe(prepared.projectPath);
  for (const key of FORBIDDEN_INTENT_KEYS) expect(Object.hasOwn(parsed, key)).toBe(false);
  const sentinel = Buffer.from([0x11, 0x22, 0x33, 0xfe]);
  expect(raw).not.toContain(sentinel.toString("base64"));
  expect(raw).not.toContain(prepared.publicationPlan?.outputs[0]?.after.base64 ?? sentinel.toString("base64"));
}

async function assertReached(fault: ConnectionCoordinatorFault, committed: ConnectionCommitResult, after: Awaited<ReturnType<typeof nativeSnapshot>>, transactionId = TX, operationId = OP): Promise<void> {
  const codes = [committed.vault.code, committed.global.code, committed.project.code, committed.reservationDiagnostic?.code];
  expect(codes).toContain("injected-fault");
  expect(after.intent).toBeDefined();
  if (fault === "after-intent") {
    expect(committed.vault.state).toBe("pending");
    expect(committed.vault.code).toBe("injected-fault");
    expect(committed.global.state).toBe("unattempted");
    expect(committed.project.state).toBe("unattempted");
    expect(committed.reservation).toBeNull();
    expect(after.settings).toBeUndefined();
    expect(after.reservation).toBeUndefined();
    expect(after.registryReceipt).toBeUndefined();
    expect(after.links).toBeUndefined();
    return;
  }
  expect(committed.vault.state).toBe("complete");
  expect(committed.vault.receipt?.transactionId).toBe(transactionId);
  expect(committed.vault.receipt?.status).toBe("complete");
  expect(after.settings).toBeDefined();
  expect(after.marker).toBeDefined();
  if (fault === "after-vault-publication") {
    expect(committed.global.state).toBe("pending");
    expect(committed.global.code).toBe("injected-fault");
    expect(committed.reservation).toBeNull();
    expect(after.reservation).toBeUndefined();
    expect(after.registry).toBeUndefined();
    expect(after.links).toBeUndefined();
    return;
  }
  expect(committed.reservation?.connectionId).toBe(ID_A);
  expect(committed.reservation?.portableVaultId).toBe(ID_A);
  expect(after.reservation).toBeDefined();
  if (fault === "after-reservation") {
    expect(committed.global.state).toBe("pending");
    expect(committed.global.code).toBe("injected-fault");
    expect(committed.global.receipt).toBeUndefined();
    expect(after.registry).toBeUndefined();
    expect(after.registryReceipt).toBeUndefined();
    expect(after.links).toBeUndefined();
    return;
  }
  expect(committed.global.state).toBe("complete");
  expect(committed.global.receipt?.operationId).toBe(operationId);
  expect(committed.global.receipt?.completed).toBe(true);
  expect(after.registryReceipt).toBeDefined();
  expect(connectionDigest(after.registry ?? Buffer.alloc(0))).toBe(committed.global.receipt?.registryDigest);
  if (fault === "after-global-upsert") {
    expect(committed.project.state).toBe("pending");
    expect(committed.project.code).toBe("injected-fault");
    expect(committed.project.receipt).toBeUndefined();
    expect(after.links).toBeUndefined();
    expect(after.projectReceipt).toBeUndefined();
    return;
  }
  expect(committed.project.state).toBe("complete");
  expect(committed.project.code).toBe("injected-fault");
  expect(committed.project.receipt?.completed).toBe(true);
  expect(committed.project.receipt?.operationId).toBe(operationId);
  expect(after.links).toBeDefined();
  expect(after.projectReceipt).toBeDefined();
}


describe("connection coordinator", () => {
  it("prepares a dry run without locks, reservation, registry, or vault writes", async () => {
    const { vaultA, registry, runtime } = await fixture();
    const before = existsSync(path.join(vaultA, ".oms"));
    const prepared = await prepareConnection({
      operationId: OP,
      target: { vault: vaultA, source: "explicit" },
      publication: settingsPublicationRequest(TX, ID_A),
      select: false,
    }, options(registry, runtime));
    expect(prepared.identityPreview).toEqual({ state: "deferred-until-reservation" });
    expect(prepared.expectedRegistryDigest).toBe("sha256:absent");
    expect(prepared.blockers).toEqual([]);
    expect(prepared.publicationPlan?.outputs.map(output => output.path)).toEqual([".oms/settings.json"]);
    expect(digestBytes(Buffer.from(prepared.publicationPlan?.outputs[0]?.after.base64 ?? "", "base64"))).toBe(prepared.publicationPlan?.outputs[0]?.after.digest);
    expect(digestBytes(prepared.canonicalTarget)).toBe(prepared.publicationPlan?.targetDigest);
    expect(existsSync(registry)).toBe(false);
    expect(existsSync(path.join(vaultA, ".oms"))).toBe(before);
    expect(existsSync(runtime)).toBe(false);
  });

  it("commits requested evidence into vault storage and keeps it out of runtime", async () => {
    const { vaultA, registry, runtime } = await fixture();
    const bytes = Uint8Array.of(1, 2, 3, 255);
    const prepared = await prepareConnection({
      operationId: OP,
      target: { vault: vaultA, source: "explicit" },
      publication: { ...settingsPublicationRequest(TX, ID_A), evidence: [{ name: "review", bytes }] },
      select: false,
    }, options(registry, runtime));
    expect(prepared.publicationPlan?.evidence[0]?.content.digest).toBe(digestBytes(bytes));
    const committed = await commitConnection(prepared, prepared.digest, options(registry, runtime));
    const stored = path.join(vaultA, ".oms", ".template-transactions", TX, "evidence", "review.bin");
    expect(committed.vault.receipt?.status).toBe("complete");
    expect(await readFile(stored)).toEqual(Buffer.from(bytes));
    expect(digestBytes(await readFile(stored))).toBe(prepared.publicationPlan?.evidence[0]?.content.digest);
    const runtimeFiles = [intentFile(runtime), reservationFile(runtime, vaultA, ID_A), registryReceiptFile(runtime)];
    for (const file of runtimeFiles) expect(await readFile(file, "utf8")).not.toContain(Buffer.from(bytes).toString("base64"));
    expect(await privateMode(path.dirname(intentFile(runtime)))).toBe(0);
  });

  it("rejects a cwd target and a settings identity mismatch before reservation", async () => {
    const { vaultA, registry, runtime } = await fixture();
    await expect(prepareConnection({
      operationId: OP,
      target: { vault: vaultA, source: "cwd" },
      publication: null,
      select: false,
    }, options(registry, runtime))).rejects.toThrow(ConnectionCoordinatorError);
    await publish(vaultA, ID_A);
    const mismatched = await prepareConnection({
      operationId: OP,
      target: { vault: vaultA, source: "explicit" },
      publication: settingsPublicationRequest(TX, ID_B),
      select: false,
    }, options(registry, runtime));
    expect(mismatched.blockers.map(item => item.code)).toContain("identity-conflict");
    expect(mismatched.blockers.find(item => item.code === "identity-conflict")?.stage).toBe("vault");
    expect(existsSync(path.join(runtime, "connection-reservations"))).toBe(false);
  });

  it("reuses a registered identity and does not select an unrelated default", async () => {
    const { vaultA, vaultB, registry, runtime } = await fixture();
    await publish(vaultA, ID_A);
    await publish(vaultB, ID_B);
    await upsertVaultConnection({
      expectedDigest: "sha256:absent",
      connectionId: ID_B,
      portableVaultId: ID_B,
      localVaultPath: vaultB,
      select: true,
      operationId: "66666666-6666-4666-8666-666666666666",
    }, options(registry, runtime));
    const prepared = await prepareConnection({
      operationId: OP,
      target: { vault: vaultA, source: "explicit" },
      publication: null,
      select: false,
    }, options(registry, runtime));
    expect(prepared.identityPreview.state).toBe("deferred-until-reservation");
    const committed = await commitConnection(prepared, prepared.digest, options(registry, runtime));
    expect(committed.reservation?.connectionId).toBe(ID_A);
    expect(committed.global.state).toBe("complete");
    expect(committed.project.state).toBe("not-requested");
    expect((await readConnectionRegistry(options(registry, runtime))).registry?.selectedConnectionId).toBe(ID_B);
  });

  it("finishes A while a v1 pointer at B stays untouched", async () => {
    const { vaultA, vaultB, project, registry, runtime } = await fixture();
    await publish(vaultA, ID_A);
    const before = await pointer(registry, vaultB);
    const projectBefore = path.join(project, ".oms", "links.yaml");
    const prepared = await prepareConnection({
      operationId: OP,
      target: { vault: vaultA, source: "explicit" },
      publication: null,
      select: true,
      project: { root: project, scope: ["notes"] },
    }, options(registry, runtime));
    const committed = await commitConnection(prepared, prepared.digest, options(registry, runtime));
    expect(committed.vault.state).toBe("not-requested");
    expect(committed.reservation?.connectionId, JSON.stringify(committed)).toBe(ID_A);
    expect(committed.global.state).toBe("pending");
    expect(committed.project.state).toBe("unattempted");
    expect(await readFile(registry, "utf8")).toContain(vaultB);
    expect(digestBytes(await readFile(registry))).toBe(before);
    expect(existsSync(projectBefore)).toBe(false);
    expect(existsSync(path.join(vaultB, ".oms"))).toBe(false);
  });

  it("does not refresh CAS after an unrelated B update", async () => {
    const { vaultA, vaultB, registry, runtime } = await fixture();
    await publish(vaultA, ID_A);
    await publish(vaultB, ID_B);
    const prepared = await prepareConnection({
      operationId: OP,
      target: { vault: vaultA, source: "explicit" },
      publication: null,
      select: false,
    }, options(registry, runtime));
    await upsertVaultConnection({
      expectedDigest: "sha256:absent",
      connectionId: ID_B,
      portableVaultId: ID_B,
      localVaultPath: vaultB,
      select: false,
      operationId: "77777777-7777-4777-8777-777777777777",
    }, options(registry, runtime));
    const committed = await commitConnection(prepared, prepared.digest, options(registry, runtime));
    expect(committed.reservation?.connectionId).toBe(ID_A);
    expect(committed.global.state).toBe("blocked");
    expect(committed.global.code).toBe("registry-blocked");
    expect((await readConnectionRegistry(options(registry, runtime))).registry?.connections.map(entry => entry.connectionId)).toEqual([ID_B]);
  });

  it("keeps a historical publication marker blocked without deleting it", async () => {
    const { vaultA, registry, runtime } = await fixture();
    await mkdir(path.join(vaultA, ".oms"), { recursive: true });
    const marker = JSON.stringify({ status: "complete" });
    await writeFile(path.join(vaultA, ".oms", "template-transaction.json"), marker);
    const prepared = await prepareConnection({
      operationId: OP,
      target: { vault: vaultA, source: "explicit" },
      publication: settingsPublicationRequest(TX, ID_A),
      select: false,
    }, options(registry, runtime));
    expect(prepared.publicationPlan).toBeNull();
    expect(prepared.blockers.some(item => item.code === "publication-blocked" && item.stage === "vault")).toBe(true);
    const committed = await commitConnection(prepared, prepared.digest, options(registry, runtime));
    expect(committed.vault.state).toBe("blocked");
    expect(committed.global.state).toBe("unattempted");
    expect(await readFile(path.join(vaultA, ".oms", "template-transaction.json"), "utf8")).toBe(marker);
  });

  it("canonicalizes a public parent-directory alias and rejects a control-file symlink before writes", async () => {
    const { root, vaultA, project, registry, runtime } = await fixture();
    const realParent = path.join(root, "real-parent");
    const aliasParent = path.join(root, "alias-parent");
    const externalVault = path.join(realParent, "vault");
    const externalProject = path.join(realParent, "project");
    await mkdir(externalVault, { recursive: true });
    await mkdir(externalProject);
    await symlink(realParent, aliasParent);
    const aliasedVault = path.join(aliasParent, "vault");
    const aliasedProject = path.join(aliasParent, "project");
    const prepared = await prepareConnection({
      operationId: OP,
      target: { vault: aliasedVault, source: "explicit" },
      publication: settingsPublicationRequest(TX, ID_A),
      select: false,
      project: { root: aliasedProject, scope: ["notes"] },
    }, options(registry, runtime));
    expect(prepared.canonicalTarget).toBe(await realpath(externalVault));
    expect(prepared.input.project?.root).toBe(await realpath(externalProject));
    const committed = await commitConnection(prepared, prepared.digest, options(registry, runtime));
    expect(committed.global.receipt?.completed).toBe(true);
    expect(committed.project.receipt?.completed).toBe(true);
    expect((await readConnectionRegistry(options(registry, runtime))).registry?.connections[0]?.localVaultPath).toBe(await realpath(externalVault));
    expect((await readProjectConnection(externalProject)).reference?.connectionId).toBe(ID_A);
    const leaf = await fixture();
    const leafParent = path.join(leaf.root, "leaf-parent");
    const leafReal = path.join(leafParent, "real-vault");
    const leafAlias = path.join(leafParent, "vault-alias");
    await mkdir(leafReal, { recursive: true });
    await symlink(leafReal, leafAlias);
    const leafPrepared = await prepareConnection({
      operationId: "99999999-9999-4999-8999-999999999999",
      target: { vault: leafAlias, source: "explicit" },
      publication: settingsPublicationRequest("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ID_B),
      select: false,
    }, { ...options(leaf.registry, leaf.runtime), createId: () => ID_C });
    expect(leafPrepared.canonicalTarget).toBe(await realpath(leafReal));
    expect((await lstat(leafAlias)).isSymbolicLink()).toBe(true);
    const leafCommitted = await commitConnection(leafPrepared, leafPrepared.digest, { ...options(leaf.registry, leaf.runtime), createId: () => ID_C });
    expect(leafCommitted.global.receipt?.completed).toBe(true);
    expect(leafCommitted.vault.receipt?.status).toBe("complete");
    const registered = (await readConnectionRegistry(options(leaf.registry, leaf.runtime))).registry?.connections ?? [];
    const canonicalLeaf = await realpath(leafReal);
    expect(registered.map(entry => entry.localVaultPath)).toContain(canonicalLeaf);
    expect(registered.some(entry => entry.localVaultPath === leafAlias)).toBe(false);
    expect(registered.find(entry => entry.localVaultPath === canonicalLeaf)?.connectionId).toBe(ID_C);

    const control = path.join(vaultA, ".oms");
    const outside = path.join(root, "outside-control");
    await mkdir(control, { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, "settings.json"), serializeVaultSettings({ version: 1, vaultId: ID_C, templateRoots: [] }));
    await symlink(path.join(outside, "settings.json"), path.join(control, "settings.json"));
    const before = await readFile(path.join(outside, "settings.json"));
    await expect(prepareConnection({
      operationId: "66666666-6666-4666-8666-666666666666",
      target: { vault: vaultA, source: "explicit" },
      publication: settingsPublicationRequest("77777777-7777-4777-8777-777777777777", ID_C),
      select: false,
      project: { root: project, scope: ["notes"] },
    }, options(registry, runtime))).resolves.toMatchObject({ publicationPlan: null });
    expect(await readFile(path.join(outside, "settings.json"))).toEqual(before);
    expect((await lstat(path.join(control, "settings.json"))).isSymbolicLink()).toBe(true);
  });

  const faults: ConnectionCoordinatorFault[] = ["after-intent", "after-vault-publication", "after-reservation", "after-global-upsert", "after-project-publication"];
  for (const [index, coordinatorFault] of faults.entries()) {
    it(`preserves sealed intent and native receipts across ${coordinatorFault} retries`, async () => {
      const operationId = `44444444-4444-4444-8444-44444444444${index}`;
      const transactionId = `55555555-5555-4555-8555-55555555555${index}`;
      const { vaultA, project, registry, runtime } = await fixture();
      await mkdir(path.join(vaultA, "notes"), { recursive: true });
      const prepared = await prepareFull(vaultA, project, registry, runtime, ["notes"], operationId, transactionId);
      const interrupted = await commitConnection(prepared, prepared.digest, options(registry, runtime, coordinatorFault));
      const afterFault = await nativeSnapshot(vaultA, project, registry, runtime, operationId);
      await assertReached(coordinatorFault, interrupted, afterFault, transactionId, operationId);
      assertIntentContent(afterFault.intent?.toString("utf8") ?? "", prepared);
      const sealed = await readFile(intentFile(runtime, operationId));
      const retries = [];
      const snapshots = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        retries.push(await commitConnection(prepared, prepared.digest, options(registry, runtime)));
        snapshots.push(await nativeSnapshot(vaultA, project, registry, runtime, operationId));
      }
      expect(await readFile(intentFile(runtime, operationId))).toEqual(sealed);
      for (const snapshot of snapshots) expect(snapshot).toEqual(snapshots[0]);
      if (afterFault.reservation !== undefined) expect(snapshots[0]?.reservation).toEqual(afterFault.reservation);
      for (const completed of retries) {
        expect(completed.vault.receipt).toEqual(retries[0]?.vault.receipt);
        expect(completed.global.receipt).toEqual(retries[0]?.global.receipt);
        expect(completed.project.receipt).toEqual(retries[0]?.project.receipt);
        expect(completed.reservation?.connectionId).toBe(retries[0]?.reservation?.connectionId);
        expect(completed.reservation?.portableVaultId).toBe(retries[0]?.reservation?.portableVaultId);
        expect(completed.reservation?.localVaultPath).toBe(retries[0]?.reservation?.localVaultPath);
        expect(completed.vault.state).toBe("complete");
        expect(completed.global.state).toBe("complete");
        expect(completed.project.state).toBe("complete");
        expect(completed.vault.receipt?.planDigest).toBe(prepared.publicationPlan?.planDigest);
        expect(completed.global.receipt?.registryDigest).toBe((await readConnectionRegistry(options(registry, runtime))).registry?.digest);
        expect(completed.project.receipt?.projectDigest).toBe((await readProjectConnection(project)).digest);
      }
      const persisted = JSON.parse(await readFile(registryReceiptFile(runtime, operationId), "utf8")) as { readonly operationId: string; readonly registryDigest: string };
      expect(persisted.operationId).toBe(retries[0]?.global.receipt?.operationId);
      expect(persisted.registryDigest).toBe(retries[0]?.global.receipt?.registryDigest);
    });
  }

  it("rejects changed settings, changed project scope, forged receipts, storage mismatch, and an in-vault runtime before later writes", async () => {
    const { root, vaultA, project, registry, runtime } = await fixture();
    await mkdir(path.join(vaultA, "notes"), { recursive: true });
    await mkdir(path.join(vaultA, "other"), { recursive: true });
    const prepared = await prepareFull(vaultA, project, registry, runtime);
    const completed = await commitConnection(prepared, prepared.digest, options(registry, runtime));
    const registryBefore = await readFile(registry);
    const reservationBefore = await readFile(reservationFile(runtime, vaultA, ID_A));
    const linksBefore = await readFile(path.join(project, ".oms", "links.yaml"));
    const projectReceiptBefore = await readFile(projectReceiptFile(runtime));
    await writeFile(path.join(vaultA, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: ID_C, templateRoots: [] }));
    const changed = await commitConnection(prepared, prepared.digest, options(registry, runtime));
    expect(changed.vault.state).toBe("blocked");
    expect(changed.vault.code).toBe("publication-blocked");
    expect(changed.global.state).toBe("unattempted");
    expect(changed.global.receipt).toBeUndefined();
    expect(changed.project.state).toBe("unattempted");
    expect(changed.project.receipt).toBeUndefined();
    expect(await readFile(registry)).toEqual(registryBefore);
    expect(await readFile(reservationFile(runtime, vaultA, ID_A))).toEqual(reservationBefore);
    expect(await readFile(path.join(project, ".oms", "links.yaml"))).toEqual(linksBefore);
    expect(await readFile(projectReceiptFile(runtime))).toEqual(projectReceiptBefore);
    expect(completed.vault.receipt?.verified.some(item => item.path === ".oms/settings.json" && item.digest !== null)).toBe(true);
    expect(await readFile(path.join(vaultA, ".oms", "settings.json"), "utf8")).toContain(ID_C);

    const scoped = await fixture();
    await mkdir(path.join(scoped.vaultA, "notes"), { recursive: true });
    await mkdir(path.join(scoped.vaultA, "other"), { recursive: true });
    const firstScope = await prepareFull(scoped.vaultA, scoped.project, scoped.registry, scoped.runtime, ["notes"]);
    await commitConnection(firstScope, firstScope.digest, options(scoped.registry, scoped.runtime));
    const firstLinks = await readFile(path.join(scoped.project, ".oms", "links.yaml"));
    const otherScope = await prepareConnection({
      operationId: "88888888-8888-4888-8888-888888888888",
      target: { vault: scoped.vaultA, source: "explicit" },
      publication: null,
      select: false,
      project: { root: scoped.project, scope: ["other"] },
    }, options(scoped.registry, scoped.runtime));
    expect(otherScope.expectedProjectDigest).toBe(connectionDigest(firstLinks));
    const scopeReplay = await commitConnection(otherScope, otherScope.digest, options(scoped.registry, scoped.runtime));
    expect(scopeReplay.project.state).toBe("complete");
    expect(scopeReplay.project.receipt?.completed).toBe(true);
    expect(scopeReplay.project.receipt?.operationId).toBe("88888888-8888-4888-8888-888888888888");
    expect(await readFile(path.join(scoped.project, ".oms", "links.yaml"), "utf8")).toContain("other");
    expect(await readFile(path.join(scoped.project, ".oms", "links.yaml"))).not.toEqual(firstLinks);
    expect((await readConnectionRegistry(options(scoped.registry, scoped.runtime))).registry?.connections.map(entry => entry.connectionId)).toEqual([ID_A]);
    await writeFile(path.join(scoped.project, ".oms", "links.yaml"), "version: [");
    const mutated = await commitConnection(firstScope, firstScope.digest, options(scoped.registry, scoped.runtime));
    expect(mutated.project.state).not.toBe("complete");
    expect(await readFile(path.join(scoped.project, ".oms", "links.yaml"), "utf8")).toBe("version: [");

    await rm(registryReceiptFile(runtime));
    const missing = await commitConnection(prepared, prepared.digest, options(registry, runtime));
    expect(missing.global.receipt).toBeUndefined();
    expect(missing.global.state).not.toBe("complete");
    expect(await bytesAt(registryReceiptFile(runtime))).toBeUndefined();

    const moved = await fixture();
    const approved = await prepareFull(moved.vaultA, moved.project, moved.registry, moved.runtime);
    const otherRegistry = path.join(moved.root, "other-registry.json");
    const inside = path.join(moved.vaultA, "runtime");
    await expect(commitConnection(approved, approved.digest, { ...options(moved.registry, moved.runtime), registryPath: otherRegistry })).rejects.toThrow(ConnectionCoordinatorError);
    await expect(commitConnection(approved, approved.digest, options(moved.registry, inside))).rejects.toThrow(ConnectionCoordinatorError);
    expect(existsSync(path.join(moved.vaultA, ".oms"))).toBe(false);
    expect(existsSync(otherRegistry)).toBe(false);
    expect(existsSync(inside)).toBe(false);
    expect(existsSync(intentFile(moved.runtime))).toBe(false);
  });

  it("seals only ids, digests, and paths and rejects a tampered blocker stage", async () => {
    const { vaultA, project, registry, runtime } = await fixture();
    const prepared = await prepareFull(vaultA, project, registry, runtime);
    await commitConnection(prepared, prepared.digest, options(registry, runtime));
    const raw = await readFile(intentFile(runtime), "utf8");
    assertIntentContent(raw, prepared);
    await expect(commitConnection({ ...prepared, blockers: [{ code: "publication-blocked", message: "tampered", stage: "global" }] }, prepared.digest, options(registry, runtime))).rejects.toThrow(/approval|mismatch|external-change/i);
    expect(await readFile(intentFile(runtime), "utf8")).toBe(raw);
  });

  it("publishes the vault when the global registry is corrupt and leaves registry bytes and reservation absent", async () => {
    const { vaultA, project, registry, runtime } = await fixture();
    await mkdir(path.dirname(registry), { recursive: true });
    const corrupt = "{not-json\n";
    await writeFile(registry, corrupt);
    const prepared = await prepareConnection({
      operationId: OP,
      target: { vault: vaultA, source: "explicit" },
      publication: settingsPublicationRequest(TX, ID_A),
      select: false,
      project: { root: project, scope: ["notes"] },
    }, options(registry, runtime));
    expect(prepared.expectedRegistryDigest).toBeNull();
    expect(prepared.blockers).toEqual([expect.objectContaining({ stage: "global", code: "registry-blocked" })]);
    expect(prepared.publicationPlan?.outputs[0]?.path).toBe(".oms/settings.json");
    expect(prepared.publicationPlan?.transactionId).toBe(TX);
    const committed = await commitConnection(prepared, prepared.digest, options(registry, runtime));
    expect(committed.vault.state).toBe("complete");
    expect(committed.vault.receipt?.planDigest).toBe(prepared.publicationPlan?.planDigest);
    expect(committed.vault.receipt?.status).toBe("complete");
    expect(committed.global.state).toBe("blocked");
    expect(committed.global.receipt).toBeUndefined();
    expect(committed.project.state).toBe("unattempted");
    expect(committed.reservation).toBeNull();
    expect(await readFile(registry, "utf8")).toBe(corrupt);
    expect(existsSync(path.join(runtime, "connection-reservations"))).toBe(false);
    expect(await readFile(path.join(vaultA, ".oms", "settings.json"), "utf8")).toContain(ID_A);
  });

  it("blocks only project publication when project metadata is corrupt after valid vault and global receipts", async () => {
    const { vaultA, project, registry, runtime } = await fixture();
    await mkdir(path.join(project, ".oms"), { recursive: true });
    const corrupt = "version: [";
    await writeFile(path.join(project, ".oms", "links.yaml"), corrupt);
    const prepared = await prepareConnection({
      operationId: OP,
      target: { vault: vaultA, source: "explicit" },
      publication: settingsPublicationRequest(TX, ID_A),
      select: false,
      project: { root: project, scope: ["notes"] },
    }, options(registry, runtime));
    expect(prepared.blockers).toEqual([expect.objectContaining({ stage: "project", code: "project-blocked" })]);
    expect(prepared.expectedRegistryDigest).toBe("sha256:absent");
    const committed = await commitConnection(prepared, prepared.digest, options(registry, runtime));
    expect(committed.vault.receipt?.status).toBe("complete");
    expect(committed.global.receipt?.completed).toBe(true);
    expect(committed.global.receipt?.operationId).toBe(OP);
    expect(committed.reservation?.connectionId).toBe(ID_A);
    expect(committed.project.state).toBe("blocked");
    expect(committed.project.receipt).toBeUndefined();
    expect(await readFile(path.join(project, ".oms", "links.yaml"), "utf8")).toBe(corrupt);
    expect((await readConnectionRegistry(options(registry, runtime))).registry?.digest).toBe(committed.global.receipt?.registryDigest);
  });

  it("rejects an NFC project scope under an NFD approval before any coordinator effect", async () => {
    const { vaultA, project, registry, runtime } = await fixture();
    const decomposed = "é".normalize("NFD");
    const composed = "é".normalize("NFC");
    expect(Buffer.from(decomposed)).not.toEqual(Buffer.from(composed));
    const prepared = await prepareConnection({
      operationId: OP,
      target: { vault: vaultA, source: "explicit" },
      publication: settingsPublicationRequest(TX, ID_A),
      select: false,
      project: { root: project, scope: [decomposed] },
    }, options(registry, runtime));
    expect(prepared.input.project?.scope).toEqual([decomposed]);
    const substituted = {
      ...prepared,
      input: { ...prepared.input, project: { root: prepared.input.project?.root ?? project, scope: [composed] } },
    };
    await expect(commitConnection(substituted, prepared.digest, options(registry, runtime))).rejects.toThrow(/approval/i);
    expect(existsSync(runtime)).toBe(false);
    expect(existsSync(registry)).toBe(false);
    expect(existsSync(path.join(project, ".oms"))).toBe(false);
    expect(existsSync(path.join(vaultA, ".oms"))).toBe(false);
  });
  it("blocks identity conflict at global when already published settings change before reservation", async () => {
    const { vaultA, registry, runtime } = await fixture();
    await publish(vaultA, ID_A);
    const prepared = await prepareConnection({
      operationId: OP,
      target: { vault: vaultA, source: "explicit" },
      publication: null,
      select: false,
    }, options(registry, runtime));
    await writeFile(path.join(vaultA, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: ID_C, templateRoots: [] }));
    const committed = await commitConnection(prepared, prepared.digest, options(registry, runtime));
    expect(committed.vault.state).toBe("not-requested");
    expect(committed.global.state).toBe("blocked");
    expect(committed.global.code).toBe("identity-conflict");
    expect(committed.reservation).toBeNull();
    expect(existsSync(registry)).toBe(false);
    expect(existsSync(reservationFile(runtime, vaultA, ID_A))).toBe(false);
    expect(await readFile(path.join(vaultA, ".oms", "settings.json"), "utf8")).toContain(ID_C);
  });

  it("rejects null and broken sealed intent before any later effect", async () => {
    const { vaultA, project, registry, runtime } = await fixture();
    const prepared = await prepareFull(vaultA, project, registry, runtime);
    const file = intentFile(runtime);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "null\n");
    await expect(commitConnection(prepared, prepared.digest, options(registry, runtime))).rejects.toThrow(/external-change|malformed|bound/i);
    expect(await readFile(file, "utf8")).toBe("null\n");
    expect(existsSync(path.join(vaultA, ".oms"))).toBe(false);
    expect(existsSync(registry)).toBe(false);
    expect(existsSync(path.join(project, ".oms"))).toBe(false);
    await writeFile(file, "{");
    await expect(commitConnection(prepared, prepared.digest, options(registry, runtime))).rejects.toThrow(/external-change|malformed/i);
    expect(await readFile(file, "utf8")).toBe("{");
    expect(existsSync(path.join(vaultA, ".oms"))).toBe(false);
    expect(existsSync(reservationFile(runtime, vaultA, ID_A))).toBe(false);
    expect(existsSync(registryReceiptFile(runtime))).toBe(false);
  });
  it("keeps a restored registry preimage pending without republishing or projecting", async () => {
    const { vaultA, project, registry, runtime } = await fixture();
    const prepared = await prepareFull(vaultA, project, registry, runtime);
    const interrupted = await commitConnection(prepared, prepared.digest, options(registry, runtime, "after-global-upsert"));
    expect(interrupted.global.state).toBe("complete");
    expect(interrupted.global.receipt?.completed).toBe(true);
    expect(interrupted.project.state).toBe("pending");
    expect(existsSync(path.join(project, ".oms", "links.yaml"))).toBe(false);
    const receiptBefore = await readFile(registryReceiptFile(runtime));
    const persisted = JSON.parse(receiptBefore.toString("utf8")) as { readonly completed: boolean; readonly registryDigest: string };
    expect(persisted.completed).toBe(true);
    expect(persisted.registryDigest).toBe(interrupted.global.receipt?.registryDigest);
    const manifest = JSON.parse(await readFile(path.join(runtime, "connection-updates", "v1", OP, "manifest.json"), "utf8")) as { readonly phase: string; readonly preimage: string | null };
    expect(manifest.phase).toBe("sealed");
    if (manifest.preimage === null) await rm(registry);
    else await writeFile(registry, manifest.preimage);
    expect(connectionDigest(await bytesAt(registry) ?? Buffer.alloc(0))).not.toBe(persisted.registryDigest);
    const retries = [];
    for (let attempt = 0; attempt < 3; attempt += 1) retries.push(await commitConnection(prepared, prepared.digest, options(registry, runtime)));
    for (const retry of retries) {
      expect(retry.global.state).toBe("pending");
      expect(retry.global.code).toBe("external-change");
      expect(retry.global.receipt?.completed).toBe(false);
      expect(retry.global.receipt?.pendingReconciliation).toBe(true);
      expect(retry.global.receipt?.operationId).toBe(OP);
      expect(retry.project.state).toBe("unattempted");
      expect(retry.project.receipt).toBeUndefined();
    }
    expect(await readFile(registryReceiptFile(runtime))).toEqual(receiptBefore);
    expect(existsSync(registry)).toBe(manifest.preimage !== null);
    expect(existsSync(path.join(project, ".oms", "links.yaml"))).toBe(false);
    expect(existsSync(projectReceiptFile(runtime))).toBe(false);
  });

  it("completes genuine V3 and empty-source V4 migration without selecting or copying source Markdown", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-migration-home-"));
    roots.push(home);
    for (const bundle of [v3Bundle(), v4Bundle(v4Policy(""), {})]) {
      const { vaultA, vaultB, registry, runtime } = await fixture();
      await installBundle(vaultA, bundle);
      await mkdir(path.join(vaultA, "Templates"), { recursive: true });
      await writeFile(path.join(vaultA, "Templates", "note.md"), "");
      const beforeB = await pointer(registry, vaultB);
      const prepared = await migrated(vaultA, registry, runtime, home);
      expect(prepared.migration.kind).toBe("schema-migration");
      expect(prepared.input.select).toBe(false);
      const committed = await commitMigratedConnection(prepared, prepared.publication, options(registry, runtime, undefined, home));
      if ("state" in committed) throw new Error(committed.state);
      expect(committed.vault.receipt?.status).toBe("complete");
      expect(committed.vault.receipt?.kind).toBe("schema-migration");
      expect(committed.global.state).toBe("pending");
      expect(committed.global.code).toBe("registry-pending");
      expect(await readFile(registry, "utf8")).toContain(vaultB);
      expect(digestBytes(await readFile(registry))).toBe(beforeB);
      expect(JSON.parse(await readFile(path.join(vaultA, ".oms", "settings.json"), "utf8")).vaultId).toBe(ID_A);
    }
  });

  it("requires a fresh identical capability before a plan exists and resumes the stored plan without one", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-migration-home-"));
    roots.push(home);
    const { vaultA, registry, runtime } = await fixture();
    await installBundle(vaultA, v4Bundle(v4Policy(""), {}));
    const prepared = await migrated(vaultA, registry, runtime, home);
    const interrupted = await commitMigratedConnection(prepared, prepared.publication, options(registry, runtime, "after-intent", home));
    if ("state" in interrupted) throw new Error(interrupted.state);
    expect(interrupted.vault.state).toBe("pending");
    expect(interrupted.vault.code).toBe("injected-fault");
    expect(interrupted.operationId).toBe(OP);
    const missing = await resumeMigratedConnection({ operationId: OP, target: { vault: vaultA, source: "explicit" } }, options(registry, runtime, undefined, home));
    expect(missing).toMatchObject({ state: "preparation-required" });
    const fresh = await prepareLegacyVaultMigration({ vault: vaultA, source: "explicit" }, { transactionId: TX, vaultId: ID_A, missingSettings: { content: serializeVaultSettings({ version: 1, vaultId: ID_A, templateRoots: [] }) } });
    if (fresh.state !== "prepared") throw new Error(fresh.state);
    const resumed = await resumeMigratedConnection({ operationId: OP, target: { vault: vaultA, source: "explicit" }, publication: fresh.publication }, options(registry, runtime, "after-plan", home));
    if ("state" in resumed) throw new Error(resumed.state);
    expect(resumed.vault.state).toBe("pending");
    const plan = await readFile(path.join(vaultA, ".oms", "migrations", TX, "plan.json"));
    const again = await resumeMigratedConnection({ operationId: OP, target: { vault: vaultA, source: "explicit" } }, options(registry, runtime, undefined, home));
    if ("state" in again) throw new Error(again.state);
    expect(again.vault.receipt?.status).toBe("complete");
    expect(await readFile(path.join(vaultA, ".oms", "migrations", TX, "plan.json"))).toEqual(plan);
  });

  it("recovers an actual after-plan native fault from a fresh child without the original capability", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-migration-child-home-"));
    roots.push(home);
    const { vaultA, registry, runtime } = await fixture();
    await installBundle(vaultA, v3Bundle());
    const childOperation = "77777777-7777-4777-8777-777777777775";
    const prepared = await migrated(vaultA, registry, runtime, home, childOperation);
    const interrupted = await commitMigratedConnection(prepared, prepared.publication, options(registry, runtime, "after-plan", home));
    if ("state" in interrupted) throw new Error(interrupted.state);
    expect(interrupted.vault).toMatchObject({ state: "pending", code: "injected-fault" });
    expect(existsSync(path.join(vaultA, ".oms", "migrations", TX, "plan.json"))).toBe(true);
    expect(existsSync(path.join(vaultA, ".oms", "migrations", TX, "complete-receipt.json"))).toBe(false);
    const childHome = await mkdtemp(path.join(tmpdir(), "oms-migration-child-env-"));
    roots.push(childHome);
    const child = execFileSync(process.execPath, ["--input-type=module", "-e", "const { resumeMigratedConnection } = await import(process.env.OMS_CHILD_COORDINATOR); const result = await resumeMigratedConnection({ operationId: process.env.OMS_CHILD_OP, target: { vault: process.env.OMS_CHILD_VAULT, source: 'explicit' } }, { registryPath: process.env.OMS_CHILD_REGISTRY, runtimeRoot: process.env.OMS_RUNTIME_ROOT, homeDir: process.env.HOME, createId: () => process.env.OMS_CHILD_ID }); if ('state' in result) throw new Error(result.state); process.stdout.write(JSON.stringify({ status: result.vault.receipt?.status, kind: result.vault.receipt?.kind, home: process.env.HOME }));"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: childHome, XDG_CONFIG_HOME: path.join(childHome, ".config"), XDG_CACHE_HOME: path.join(childHome, ".cache"), OMS_RUNTIME_ROOT: runtime, OMS_CHILD_COORDINATOR: fileURLToPath(new URL("../../../dist/kernel/install/connection-coordinator.js", import.meta.url)), OMS_CHILD_VAULT: vaultA, OMS_CHILD_OP: childOperation, OMS_CHILD_REGISTRY: registry, OMS_CHILD_ID: ID_A },
    });
    expect(JSON.parse(child)).toEqual({ status: "complete", kind: "schema-migration", home: childHome });
  });

  it("refuses a missing target, another existing vault, wrong options, tampered metadata, a changed pointer, and a corrupt receipt", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-migration-home-"));
    roots.push(home);
    const { vaultA, vaultB, registry, runtime } = await fixture();
    await installBundle(vaultA, v4Bundle(v4Policy(""), {}));
    await pointer(registry, vaultB);
    const prepared = await migrated(vaultA, registry, runtime, home);
    const committed = await commitMigratedConnection(prepared, prepared.publication, options(registry, runtime, undefined, home));
    if ("state" in committed) throw new Error(committed.state);
    const intent = intentFile(runtime);
    const original = await readFile(intent, "utf8");
    const changed = original.replace(prepared.migration.planDigest, "sha256:" + "ab".repeat(32));
    await writeFile(intent, changed);
    await expect(resumeMigratedConnection({ operationId: OP, target: { vault: vaultA, source: "explicit" } }, options(registry, runtime, undefined, home))).rejects.toThrow(ConnectionCoordinatorError);
    await writeFile(intent, original);
    const missingTarget = path.join(path.dirname(vaultA), "missing-target");
    await expect(resumeMigratedConnection({ operationId: OP, target: { vault: missingTarget, source: "explicit" } }, options(registry, runtime, undefined, home))).rejects.toThrow(/target|ENOENT|unsafe/i);
    await expect(resumeMigratedConnection({ operationId: OP, target: { vault: vaultB, source: "explicit" } }, options(registry, runtime, undefined, home))).rejects.toThrow(/target|external-change/i);
    await expect(resumeMigratedConnection({ operationId: OP, target: { vault: vaultA, source: "explicit" } }, { ...options(registry, runtime, undefined, home), runtimeRoot: path.join(runtime, "other") })).rejects.toThrow(/options|external-change/i);
    const sealedPointer = await readFile(registry);
    await writeFile(registry, sealedPointer.toString("utf8").replace(vaultB, vaultA));
    const malformedReplay = await resumeMigratedConnection({ operationId: OP, target: { vault: vaultA, source: "explicit" } }, options(registry, runtime, undefined, home));
    if ("state" in malformedReplay) throw new Error(malformedReplay.state);
    expect(malformedReplay.global).toMatchObject({ state: "blocked", code: "registry-blocked" });
    await pointer(registry, vaultA);
    const changedPointer = await readFile(registry);
    const pointerReplay = await resumeMigratedConnection({ operationId: OP, target: { vault: vaultA, source: "explicit" } }, options(registry, runtime, undefined, home));
    if ("state" in pointerReplay) throw new Error(pointerReplay.state);
    expect(pointerReplay.global).toMatchObject({ state: "pending", code: "external-change" });
    expect(await readFile(registry)).toEqual(changedPointer);
    expect(await readFile(path.join(vaultA, ".oms", "settings.json"), "utf8")).toContain(ID_A);
    const receipt = path.join(vaultA, ".oms", "migrations", TX, "complete-receipt.json");
    const receiptBefore = await readFile(receipt);
    await writeFile(receipt, "{");
    const corrupt = await resumeMigratedConnection({ operationId: OP, target: { vault: vaultA, source: "explicit" } }, options(registry, runtime, undefined, home));
    if ("state" in corrupt) throw new Error(corrupt.state);
    expect(corrupt.vault.state).toBe("blocked");
    expect(await readFile(receipt, "utf8")).toBe("{");
    await writeFile(receipt, receiptBefore);
  });

  it("retains transaction identity and native plan bytes across repeated faults", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-migration-home-"));
    roots.push(home);
    const { vaultA, registry, runtime } = await fixture();
    const faultOperation = "77777777-7777-4777-8777-777777777771";
    await installBundle(vaultA, v3Bundle());
    const prepared = await migrated(vaultA, registry, runtime, home, faultOperation);
    await commitMigratedConnection(prepared, prepared.publication, options(registry, runtime, "after-vault-publication", home));
    const plan = await readFile(path.join(vaultA, ".oms", "migrations", TX, "plan.json"));
    const first = await resumeMigratedConnection({ operationId: faultOperation, target: { vault: vaultA, source: "explicit" } }, options(registry, runtime, "after-reservation", home));
    const second = await resumeMigratedConnection({ operationId: faultOperation, target: { vault: vaultA, source: "explicit" } }, options(registry, runtime, undefined, home));
    if ("state" in first || "state" in second) throw new Error("preparation");
    expect(first.operationId).toBe(faultOperation);
    expect(second.vault.receipt?.transactionId).toBe(TX);
    expect(await readFile(path.join(vaultA, ".oms", "migrations", TX, "plan.json"))).toEqual(plan);
    expect(second.reservation?.portableVaultId).toBe(ID_A);
  });

  it("returns review-required for an existing policy without verified evidence and writes nothing", async () => {
    const { vaultA } = await fixture();
    const bundle = v4Bundle(v4Policy("needs review"), {});
    await installBundle(vaultA, bundle);
    const before = await readFile(path.join(vaultA, bundle.markerPath));
    const prepared = await prepareLegacyVaultMigration({ vault: vaultA, source: "explicit" }, { transactionId: TX, vaultId: ID_A });
    expect(prepared.state).toBe("review-required");
    if (prepared.state !== "review-required") return;
    expect(prepared.admission.status).not.toBe("absent");
    expect("publication" in prepared).toBe(false);
    expect(await readFile(path.join(vaultA, bundle.markerPath))).toEqual(before);
    expect(existsSync(path.join(vaultA, ".oms", "settings.json"))).toBe(false);
    expect(existsSync(path.join(vaultA, ".oms", ".template-transactions", TX))).toBe(false);
  });

  it("returns setup-required for absent legacy evidence and does not invent settings or policy", async () => {
    const { vaultA, registry, runtime } = await fixture();
    const before = existsSync(path.join(vaultA, ".oms"));
    const prepared = await prepareLegacyVaultMigration({ vault: vaultA, source: "explicit" }, { transactionId: TX, vaultId: ID_A, missingSettings: { content: serializeVaultSettings({ version: 1, vaultId: ID_A, templateRoots: [] }) } });
    expect(prepared.state).toBe("setup-required");
    if (prepared.state !== "setup-required") return;
    expect(prepared.admission.status).toBe("absent");
    expect(existsSync(path.join(vaultA, ".oms"))).toBe(before);
    expect(existsSync(registry)).toBe(false);
    expect(existsSync(runtime)).toBe(false);
    await expect(prepareMigratedConnection({ operationId: OP, target: { vault: vaultA, source: "explicit" }, publication: {} as PreparedLegacyMigration, select: false }, options(registry, runtime))).rejects.toThrow(/capability|registered/i);
  });

  it("refuses generic reuse of a sealed migration intent for another target or options", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-migration-home-"));
    roots.push(home);
    const { vaultA, vaultB, registry, runtime } = await fixture();
    await installBundle(vaultA, v3Bundle());
    const faultOperation = "77777777-7777-4777-8777-777777777773";
    const prepared = await migrated(vaultA, registry, runtime, home, faultOperation);
    const interrupted = await commitMigratedConnection(prepared, prepared.publication, options(registry, runtime, "after-intent", home));
    if ("state" in interrupted) throw new Error(interrupted.state);
    expect(interrupted.vault.state).toBe("pending");
    expect(interrupted.vault.code).toBe("injected-fault");
    expect(interrupted.operationId).toBe(faultOperation);
    expect(interrupted).toMatchObject({ operationId: faultOperation, vault: { state: "pending", code: "injected-fault" } });
    const generic = await prepareConnection({ operationId: faultOperation, target: { vault: vaultB, source: "explicit" }, publication: settingsPublicationRequest(TX, ID_B), select: true }, options(registry, runtime, undefined, home));
    await expect(commitConnection(generic, generic.digest, options(registry, runtime, undefined, home))).rejects.toMatchObject({ code: "external-change" });
    expect(await readFile(intentFile(runtime, faultOperation), "utf8")).toContain(vaultA);
    expect(existsSync(path.join(vaultB, ".oms"))).toBe(false);
  });

  it("rejects forged migration project state before any write", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-migration-home-"));
    roots.push(home);
    const { vaultA, project, registry, runtime } = await fixture();
    await installBundle(vaultA, v3Bundle());
    const prepared = await migrated(vaultA, registry, runtime, home);
    const forged = { ...prepared, input: { ...prepared.input, project: { root: project, scope: ["notes"] } }, projectPath: path.join(project, ".oms", "links.yaml") };
    await expect(commitMigratedConnection(forged, prepared.publication, options(registry, runtime, undefined, home))).rejects.toThrow(ConnectionCoordinatorError);
    expect(existsSync(intentFile(runtime))).toBe(false);
    expect(existsSync(path.join(project, ".oms"))).toBe(false);
  });

  it("replays a completed and pending global receipt from the original CAS without replanning", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-migration-home-"));
    roots.push(home);
    const { vaultA, registry, runtime } = await fixture();
    await installBundle(vaultA, v4Bundle(v4Policy(""), {}));
    const prepared = await migrated(vaultA, registry, runtime, home);
    const first = await commitMigratedConnection(prepared, prepared.publication, options(registry, runtime, undefined, home));
    if ("state" in first) throw new Error(first.state);
    const receipt = await readFile(registryReceiptFile(runtime));
    const replay = await resumeMigratedConnection({ operationId: OP, target: { vault: vaultA, source: "explicit" } }, options(registry, runtime, undefined, home));
    if ("state" in replay) throw new Error(replay.state);
    expect(replay.global.receipt?.registryDigest).toBe(first.global.receipt?.registryDigest);
    expect(await readFile(registryReceiptFile(runtime))).toEqual(receipt);
    const pending = await fixture();
    await installBundle(pending.vaultA, v3Bundle());
    const pendingPrepared = await migrated(pending.vaultA, pending.registry, pending.runtime, home);
    await commitMigratedConnection(pendingPrepared, pendingPrepared.publication, options(pending.registry, pending.runtime, "after-global-upsert", home));
    const pendingReceipt = await readFile(registryReceiptFile(pending.runtime));
    const pendingReplay = await resumeMigratedConnection({ operationId: OP, target: { vault: pending.vaultA, source: "explicit" } }, options(pending.registry, pending.runtime, undefined, home));
    if ("state" in pendingReplay) throw new Error(pendingReplay.state);
    expect(pendingReplay.global.state).toBe("complete");
    expect(await readFile(registryReceiptFile(pending.runtime))).toEqual(pendingReceipt);
  });

  it("restarts after the actual vault publication fault without a fresh capability", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-migration-home-"));
    roots.push(home);
    const { vaultA, registry, runtime } = await fixture();
    const faultOperation = "77777777-7777-4777-8777-777777777772";
    await installBundle(vaultA, v3Bundle());
    const prepared = await migrated(vaultA, registry, runtime, home, faultOperation);
    const interrupted = await commitMigratedConnection(prepared, prepared.publication, options(registry, runtime, "after-vault-publication", home));
    if ("state" in interrupted) throw new Error(interrupted.state);
    expect(interrupted.vault.state).toBe("complete");
    expect(interrupted.global.state).toBe("pending");
    const plan = await readFile(path.join(vaultA, ".oms", "migrations", TX, "plan.json"));
    const resumed = await resumeMigratedConnection({ operationId: faultOperation, target: { vault: vaultA, source: "explicit" } }, options(registry, runtime, undefined, home));
    if ("state" in resumed) throw new Error(resumed.state);
    expect(resumed.reservation?.portableVaultId).toBe(ID_A);
    expect(await readFile(path.join(vaultA, ".oms", "migrations", TX, "plan.json"))).toEqual(plan);
  });

  it("cold-resumes an already registered vault with existing settings and admitted source provenance", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-migration-home-"));
    roots.push(home);
    const operationId = "77777777-7777-4777-8777-777777777774";
    const { vaultA, registry, runtime } = await fixture();
    const bundle = v4Bundle(v4Policy(""), {});
    await installBundle(vaultA, bundle);
    await publish(vaultA, ID_A);
    await upsertVaultConnection({ expectedDigest: "sha256:absent", portableVaultId: ID_A, localVaultPath: vaultA, select: false, operationId: "77777777-7777-4777-8777-777777777775" }, options(registry, runtime, undefined, home));
    const prepared = await migrated(vaultA, registry, runtime, home, operationId);
    expect(prepared.publicationPolicy.policy.templates?.note?.source?.path).toBe("Templates/note.md");
    const committed = await commitMigratedConnection(prepared, prepared.publication, options(registry, runtime, "after-vault-publication", home));
    if ("state" in committed) throw new Error(committed.state);
    const resumed = await resumeMigratedConnection({ operationId, target: { vault: vaultA, source: "vault" } }, options(registry, runtime, undefined, home));
    if ("state" in resumed) throw new Error(resumed.state);
    expect(resumed.global.state).toBe("complete");
    expect(resumed.reservation?.portableVaultId).toBe(ID_A);
    expect(JSON.parse(await readFile(path.join(vaultA, ".oms", "settings.json"), "utf8")).vaultId).toBe(ID_A);
    expect(await readFile(path.join(vaultA, "Templates", "note.md"), "utf8")).toBe("");
  });

  it("holds markerless existing policy for review and isolates the returned candidate copy", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-migration-home-"));
    roots.push(home);
    const { vaultA, registry, runtime } = await fixture();
    await mkdir(path.join(vaultA, ".oms"), { recursive: true });
    const markerless = Buffer.from(JSON.stringify(v4Policy("")));
    await writeFile(path.join(vaultA, ".oms", "template-policy.json"), markerless);
    const held = await prepareLegacyVaultMigration({ vault: vaultA, source: "explicit" }, { transactionId: TX, vaultId: ID_A });
    expect(held.state).toBe("review-required");
    expect(existsSync(path.join(vaultA, ".oms", "settings.json"))).toBe(false);
    const verified = await fixture();
    await installBundle(verified.vaultA, v4Bundle(v4Policy(""), {}));
    const prepared = await migrated(verified.vaultA, registry, runtime, home);
    const returned = prepared.publicationPolicy;
    (returned as { canonicalPolicy: string }).canonicalPolicy = "mutated";
    const again = await prepareLegacyVaultMigration({ vault: verified.vaultA, source: "explicit" }, { transactionId: TX, vaultId: ID_A, missingSettings: { content: serializeVaultSettings({ version: 1, vaultId: ID_A, templateRoots: [] }) } });
    if (again.state !== "prepared") throw new Error(again.state);
    expect(again.policy.canonicalPolicy).not.toBe("mutated");
    expect(await readFile(path.join(vaultA, ".oms", "template-policy.json"))).toEqual(markerless);
  });
  it("treats connection intent as a read-only hint and preserves malformed bytes", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-intent-home-"));
    roots.push(home);
    const { vaultA, registry, runtime } = await fixture();
    const before = existsSync(runtime);
    await expect(hasConnectionIntent(OP, options(registry, runtime, undefined, home))).resolves.toBe(false);
    expect(existsSync(runtime)).toBe(before);
    await installBundle(vaultA, v3Bundle());
    const prepared = await migrated(vaultA, registry, runtime, home);
    await commitMigratedConnection(prepared, prepared.publication, options(registry, runtime, "after-intent", home));
    const intent = intentFile(runtime);
    const sealed = await readFile(intent);
    await expect(hasConnectionIntent(OP, options(registry, runtime, undefined, home))).resolves.toBe(true);
    expect(await readFile(intent)).toEqual(sealed);
    await writeFile(intent, "{");
    await expect(hasConnectionIntent(OP, options(registry, runtime, undefined, home))).rejects.toThrow(ConnectionCoordinatorError);
    expect(await readFile(intent, "utf8")).toBe("{");
  });
});

async function installBundle(vault: string, bundle: HistoricalBundle): Promise<void> {
  const files: Record<string, Uint8Array> = { [bundle.markerPath]: bundle.markerBytes, [bundle.planPath]: bundle.planBytes, ...bundle.observed };
  const templates = JSON.parse(Buffer.from(bundle.policy).toString("utf8")).templates as Record<string, { source?: { path?: string }; approvedMarkdown?: string }> | undefined;
  for (const template of Object.values(templates ?? {})) {
    if (template.source?.path !== undefined) files[template.source.path] = Buffer.from(template.approvedMarkdown ?? "");
  }
  for (const [relative, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(vault, relative)), { recursive: true });
    await writeFile(path.join(vault, relative), bytes);
  }
}
async function migrated(vault: string, registry: string, runtime: string, home: string, operationId = OP): Promise<PreparedMigratedConnection & { readonly publication: PreparedLegacyMigration; readonly publicationPolicy: LegacyEquivalenceCandidate }> {
  const prepared = await prepareLegacyVaultMigration({ vault, source: "explicit" }, { transactionId: TX, vaultId: ID_A, ...(existsSync(path.join(vault, ".oms", "settings.json")) ? {} : { missingSettings: { content: serializeVaultSettings({ version: 1, vaultId: ID_A, templateRoots: [] }) } }) });
  if (prepared.state !== "prepared") throw new Error(prepared.admission.reasons.join("; ") || prepared.state);
  const connection = await prepareMigratedConnection({ operationId, target: { vault, source: "explicit" }, publication: prepared.publication, select: false }, options(registry, runtime, undefined, home));
  return { ...connection, publication: prepared.publication, publicationPolicy: prepared.policy };
}
