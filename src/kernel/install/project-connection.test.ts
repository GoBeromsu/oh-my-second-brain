import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { mkdir as mkdirLock, writeFile as writeLockFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { readConnectionRegistry, upsertVaultConnection } from "./connection-registry.js";
import { ProjectConnectionError, readProjectConnection, updateProjectConnection, type ProjectConnectionFault } from "./project-connection.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";
const OP = "44444444-4444-4444-8444-444444444444";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ readonly root: string; readonly vaultA: string; readonly vaultB: string; readonly projectA: string; readonly projectB: string; readonly registry: string; readonly runtime: string }> {
  const created = await mkdtemp(path.join(tmpdir(), "oms-project-connection-"));
  const root = await realpath(created);
  roots.push(root);
  const vaultA = path.join(root, "vault-a");
  const vaultB = path.join(root, "vault-b");
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  await Promise.all([mkdir(vaultA), mkdir(vaultB), mkdir(path.join(projectA, ".oms"), { recursive: true }), mkdir(projectB)]);
  return { root, vaultA, vaultB, projectA, projectB, registry: path.join(root, "xdg", "oms", "vault.json"), runtime: path.join(root, "runtime") };
}

function options(registry: string, runtime: string) {
  return { registryPath: registry, runtimeRoot: runtime, createId: () => ID_A };
}

async function reason(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectConnectionError);
    return error instanceof ProjectConnectionError ? error.reason : "untyped";
  }
  throw new Error("expected ProjectConnectionError");
}

function bind(projectRoot: string, receipt: Awaited<ReturnType<typeof upsertVaultConnection>>, extra: { readonly expectedRegistryDigest?: string; readonly expectedProjectDigest?: string; readonly scope?: readonly string[]; readonly connectionId?: string; readonly portableVaultId?: string; readonly operationId?: string; readonly fault?: ProjectConnectionFault } = {}) {
  return {
    projectRoot,
    connectionId: extra.connectionId ?? ID_A,
    portableVaultId: extra.portableVaultId ?? ID_B,
    scope: extra.scope ?? ["notes"],
    expectedRegistryDigest: extra.expectedRegistryDigest ?? receipt.registryDigest,
    expectedProjectDigest: extra.expectedProjectDigest ?? "sha256:absent",
    registryReceipt: receipt,
    operationId: extra.operationId ?? OP,
    ...(extra.fault === undefined ? {} : { fault: extra.fault }),
  };
}

describe("project connection", () => {
  it("reads a portable v2 reference and rejects an absolute vault member without writing", async () => {
    const { projectA, runtime } = await fixture();
    const links = path.join(projectA, ".oms", "links.yaml");
    await writeFile(links, yamlStringify({ version: 2, connectionId: ID_A, portableVaultId: ID_B, scope: ["notes"], vendor: { keep: true } }), "utf8");
    const read = await readProjectConnection(projectA);
    expect(read.reference).toMatchObject({ connectionId: ID_A, portableVaultId: ID_B, scope: ["notes"], unknown: { vendor: { keep: true } } });
    expect(existsSync(runtime)).toBe(false);
    await writeFile(links, yamlStringify({ version: 2, connectionId: ID_A, portableVaultId: ID_B, scope: ["notes"], vault: "/abs" }), "utf8");
    expect(await reason(readProjectConnection(projectA))).toBe("unsupported-record");
  });

  it("refuses unknown v1 members and a vault path that does not belong to the selected entry", async () => {
    const { vaultA, vaultB, projectA, registry, runtime } = await fixture();
    const created = await upsertVaultConnection({ expectedDigest: "sha256:absent", portableVaultId: ID_B, localVaultPath: vaultA, connectionId: ID_A, select: true, operationId: "55555555-5555-4555-8555-555555555555" }, options(registry, runtime));
    const links = path.join(projectA, ".oms", "links.yaml");
    await writeFile(links, yamlStringify({ version: 1, vault: vaultB, scope: ["notes"], hostModel: "secret" }), "utf8");
    const current = await readProjectConnection(projectA);
    expect(await reason(updateProjectConnection(bind(projectA, created, { expectedProjectDigest: current.digest ?? "" }), options(registry, runtime)))).toBe("unknown-semantics");
    await writeFile(links, yamlStringify({ version: 1, vault: vaultB, scope: ["notes"] }), "utf8");
    const wrong = await readProjectConnection(projectA);
    expect(await reason(updateProjectConnection(bind(projectA, created, { expectedProjectDigest: wrong.digest ?? "" }), options(registry, runtime)))).toBe("identity-conflict");
    expect(await readFile(links, "utf8")).toContain(vaultB);
  });

  it("commits the registry first, leaves project pending on external bytes, and retries the same input without republishing", async () => {
    const { vaultA, projectA, registry, runtime } = await fixture();
    const created = await upsertVaultConnection({ expectedDigest: "sha256:absent", portableVaultId: ID_B, localVaultPath: vaultA, connectionId: ID_A, select: true, operationId: "55555555-5555-4555-8555-555555555555" }, options(registry, runtime));
    const links = path.join(projectA, ".oms", "links.yaml");
    await writeFile(links, yamlStringify({ version: 1, vault: vaultA, scope: ["notes"] }), "utf8");
    const current = await readProjectConnection(projectA);
    const input = bind(projectA, created, { expectedProjectDigest: current.digest ?? "", scope: ["notes", "projects"] });
    const committed = await updateProjectConnection(input, options(registry, runtime));
    expect(committed.completed).toBe(true);
    expect(committed.vaultWritten).toBe(false);
    expect(await readFile(links, "utf8")).not.toContain(vaultA);
    const external = yamlStringify({ version: 2, connectionId: ID_C, portableVaultId: ID_C, scope: ["other"] });
    await writeFile(links, external, "utf8");
    const replay = await updateProjectConnection(input, options(registry, runtime));
    expect(replay.pendingReconciliation).toBe(true);
    expect(replay.globalCommitted).toBe(true);
    expect(await readFile(links, "utf8")).toBe(external);
    expect((await readConnectionRegistry(options(registry, runtime))).registry?.digest).toBe(replay.registryDigest);
  });

  it("retries the same original input three times after each fault boundary", async () => {
    const boundaries: ProjectConnectionFault[] = ["after-manifest", "after-backup", "after-global-commit", "after-project-publish", "before-receipt"];
    for (const boundary of boundaries) {
      const { vaultA, projectA, registry, runtime } = await fixture();
      const created = await upsertVaultConnection({ expectedDigest: "sha256:absent", portableVaultId: ID_B, localVaultPath: vaultA, connectionId: ID_A, select: true, operationId: "55555555-5555-4555-8555-555555555555" }, options(registry, runtime));
      const input = bind(projectA, created, { fault: boundary });
      expect(await reason(updateProjectConnection(input, options(registry, runtime)))).toBe("injected-fault");
      const recovered = [];
      for (let attempt = 0; attempt < 3; attempt += 1) recovered.push(await updateProjectConnection({ ...input, fault: undefined }, options(registry, runtime)));
      expect(recovered.every(item => item.completed && item.inputDigest === recovered[0]?.inputDigest && item.registryDigest === recovered[0]?.registryDigest)).toBe(true);
    }
  });

  it("rejects a symbolic project path and preserves an unrelated registry entry", async () => {
    const { root, vaultA, vaultB, projectA, registry, runtime } = await fixture();
    const first = await upsertVaultConnection({ expectedDigest: "sha256:absent", portableVaultId: ID_B, localVaultPath: vaultA, connectionId: ID_A, select: true, operationId: "55555555-5555-4555-8555-555555555555" }, options(registry, runtime));
    const latest = await upsertVaultConnection({ expectedDigest: first.registryDigest, portableVaultId: ID_C, localVaultPath: vaultB, connectionId: ID_C, select: false, operationId: "66666666-6666-4666-8666-666666666666" }, options(registry, runtime));
    const beforeB = (await readConnectionRegistry(options(registry, runtime))).registry?.connections.find(entry => entry.connectionId === ID_C);
    const alias = path.join(root, "project-link");
    await symlink(projectA, alias);
    expect(await reason(updateProjectConnection(bind(alias, latest), options(registry, runtime)))).toBe("unsafe-target");
    const updated = await updateProjectConnection(bind(projectA, latest), options(registry, runtime));
    expect(updated.completed).toBe(true);
    expect((await readConnectionRegistry(options(registry, runtime))).registry?.connections.find(entry => entry.connectionId === ID_C)).toEqual(beforeB);
  });
  it("rejects a forged registry receipt and a live project lock without takeover", async () => {
    const { vaultA, projectA, registry, runtime } = await fixture();
    const created = await upsertVaultConnection({ expectedDigest: "sha256:absent", portableVaultId: ID_B, localVaultPath: vaultA, connectionId: ID_A, select: true, operationId: "55555555-5555-4555-8555-555555555555" }, options(registry, runtime));
    const forged = { ...created, registryPath: path.join(runtime, "other.json"), completed: true };
    expect(await reason(updateProjectConnection({ ...bind(projectA, created), registryReceipt: forged }, options(registry, runtime)))).toBe("receipt-conflict");
    const lock = path.join(projectA, ".oms", "links.yaml.lock");
    await mkdirLock(lock);
    await writeLockFile(path.join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, token: "live" })}\n`);
    expect(await reason(updateProjectConnection(bind(projectA, created, { operationId: "66666666-6666-4666-8666-666666666666" }), options(registry, runtime)))).toBe("locked");
  });

  it("lets only one concurrent project operation commit the same links file", async () => {
    const { vaultA, projectA, registry, runtime } = await fixture();
    const created = await upsertVaultConnection({ expectedDigest: "sha256:absent", portableVaultId: ID_B, localVaultPath: vaultA, connectionId: ID_A, select: true, operationId: "55555555-5555-4555-8555-555555555555" }, options(registry, runtime));
    const results = await Promise.allSettled([
      updateProjectConnection(bind(projectA, created), options(registry, runtime)),
      updateProjectConnection(bind(projectA, created, { scope: ["projects"], operationId: "66666666-6666-4666-8666-666666666666" }), options(registry, runtime)),
    ]);
    expect(results.filter(result => result.status === "fulfilled" && result.value.completed).length).toBe(1);
    expect(results.some(result => result.status === "rejected" || (result.status === "fulfilled" && result.value.pendingReconciliation))).toBe(true);
  });
  it("links unselected A without selecting it or rewriting globally selected B", async () => {
    const { vaultA, vaultB, projectA, registry, runtime } = await fixture();
    const selected = await upsertVaultConnection({ expectedDigest: "sha256:absent", portableVaultId: ID_C, localVaultPath: vaultB, connectionId: ID_C, select: true, operationId: "66666666-6666-4666-8666-666666666666" }, options(registry, runtime));
    const unselected = await upsertVaultConnection({ expectedDigest: selected.registryDigest, portableVaultId: ID_B, localVaultPath: vaultA, connectionId: ID_A, select: false, operationId: "55555555-5555-4555-8555-555555555555" }, options(registry, runtime));
    const before = await readFile(registry);
    const committed = await updateProjectConnection(bind(projectA, unselected), options(registry, runtime));
    const after = await readConnectionRegistry(options(registry, runtime));
    expect(committed.completed).toBe(true);
    expect(await readFile(registry)).toEqual(before);
    expect(after.registry?.selectedConnectionId).toBe(ID_C);
    expect(after.registry?.connections.find(entry => entry.connectionId === ID_C)?.revision).toBe("1");
    expect((await readProjectConnection(projectA)).reference).toMatchObject({ connectionId: ID_A, portableVaultId: ID_B });
  });

  it("rejects a missing, forged, mismatched, or stale receipt before creating project control state", async () => {
    const { vaultA, vaultB, projectA, registry, runtime } = await fixture();
    const created = await upsertVaultConnection({ expectedDigest: "sha256:absent", portableVaultId: ID_B, localVaultPath: vaultA, connectionId: ID_A, select: false, operationId: "55555555-5555-4555-8555-555555555555" }, options(registry, runtime));
    const before = await readFile(registry);
    const absent = { ...bind(projectA, created) };
    const { registryReceipt: _receipt, ...missing } = absent;
    expect(await reason(updateProjectConnection(missing as typeof absent, options(registry, runtime)))).toBe("receipt-conflict");
    expect(await readFile(registry)).toEqual(before);
    expect(existsSync(path.join(runtime, "connection-updates", "v1", OP))).toBe(false);
    const forged = { ...created, completed: false };
    expect(await reason(updateProjectConnection({ ...bind(projectA, created), registryReceipt: forged }, options(registry, runtime)))).toBe("receipt-conflict");
    expect(existsSync(path.join(runtime, "connection-updates", "v1", OP))).toBe(false);
    const tampered = { ...created, inputDigest: "sha256:" + "ab".repeat(32) };
    expect(await reason(updateProjectConnection({ ...bind(projectA, created), registryReceipt: tampered }, options(registry, runtime)))).toBe("receipt-conflict");
    expect(existsSync(path.join(runtime, "connection-updates", "v1", OP))).toBe(false);
    const latestB = await upsertVaultConnection({ expectedDigest: created.registryDigest, portableVaultId: ID_C, localVaultPath: vaultB, connectionId: ID_C, select: true, operationId: "77777777-7777-4777-8777-777777777777" }, options(registry, runtime));
    const afterB = await readFile(registry);
    const missingId = "88888888-8888-4888-8888-888888888888";
    expect(await reason(updateProjectConnection(bind(projectA, latestB, { connectionId: missingId, portableVaultId: ID_B }), options(registry, runtime)))).toBe("identity-conflict");
    expect(await reason(updateProjectConnection(bind(projectA, latestB, { connectionId: ID_A, portableVaultId: ID_C }), options(registry, runtime)))).toBe("identity-conflict");
    expect(await readFile(registry)).toEqual(afterB);
    expect(existsSync(path.join(runtime, "connection-updates", "v1", OP))).toBe(false);
    expect(existsSync(path.join(projectA, ".oms", "links.yaml"))).toBe(false);
    const linked = await updateProjectConnection(bind(projectA, latestB), options(registry, runtime));
    expect(linked.completed).toBe(true);
    expect(await readFile(registry)).toEqual(afterB);
    expect((await readConnectionRegistry(options(registry, runtime))).registry?.selectedConnectionId).toBe(ID_C);
    const staleOp = "99999999-9999-4999-8999-999999999999";
    expect(await reason(updateProjectConnection(bind(projectA, created, { expectedRegistryDigest: "sha256:" + "0".repeat(64), operationId: staleOp }), options(registry, runtime)))).toBe("receipt-conflict");
    expect(existsSync(path.join(runtime, "connection-updates", "v1", staleOp))).toBe(false);
  });
});

