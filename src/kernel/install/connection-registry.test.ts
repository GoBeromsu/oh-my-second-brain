import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConnectionRegistryError,
  connectionRegistryPath,
  type ConnectionRegistryFault,
  migrateHostVaultPointer,
  readConnectionRegistry,
  upsertVaultConnection,
  reserveVaultConnection,
} from "./connection-registry.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";
const OP = "44444444-4444-4444-8444-444444444444";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ readonly root: string; readonly vaultA: string; readonly vaultB: string; readonly registry: string; readonly runtime: string }> {
  const created = await mkdtemp(path.join(tmpdir(), "oms-connection-registry-"));
  const root = await realpath(created);
  roots.push(root);
  const vaultA = path.join(root, "vault-a");
  const vaultB = path.join(root, "vault-b");
  await Promise.all([mkdir(vaultA), mkdir(vaultB)]);
  return {
    root,
    vaultA,
    vaultB,
    registry: connectionRegistryPath({ XDG_CONFIG_HOME: path.join(root, "xdg") }, root),
    runtime: path.join(root, "runtime"),
  };
}

function options(registry: string, runtime: string, fault?: ConnectionRegistryFault): { readonly registryPath: string; readonly runtimeRoot: string; readonly createId: () => string; readonly fault?: ConnectionRegistryFault } {
  return { registryPath: registry, runtimeRoot: runtime, createId: () => ID_A, fault };
}

function signatureFor(vault: string): string {
  return createHash("sha256").update(`oms-host-vault-pointer\n1\n${vault}\n`).digest("hex");
}

async function writePointer(registry: string, vault: string, extra?: Record<string, unknown>): Promise<string> {
  await mkdir(path.dirname(registry), { recursive: true });
  const record = { version: 1, vault, signature: signatureFor(vault), ...extra };
  const raw = `${JSON.stringify(record)}\n`;
  await writeFile(registry, raw, "utf8");
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

async function reason(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectionRegistryError);
    return error instanceof ConnectionRegistryError ? error.reason : "untyped";
  }
  throw new Error("expected ConnectionRegistryError");
}

async function publishIdentity(vault: string, vaultId: string): Promise<void> {
  await mkdir(path.join(vault, ".oms"));
  await writeFile(path.join(vault, ".oms", "settings.json"), `${JSON.stringify({ version: 1, vaultId, templateRoots: ["Templates"] })}\n`, "utf8");
}

function reservationFile(runtime: string, canonical: string, portableVaultId: string): string {
  const key = createHash("sha256").update(`${canonical}\0${portableVaultId}`).digest("hex");
  return path.join(runtime, "connection-reservations", "v1", `${key}.json`);
}

describe("connection registry", () => {
  it("reads missing state without creating files and resolves the injected XDG path", async () => {
    const { root, registry, runtime } = await fixture();
    const read = await readConnectionRegistry(options(registry, runtime));
    expect(read).toEqual({ path: registry, state: "missing" });
    expect(existsSync(registry)).toBe(false);
    expect(existsSync(runtime)).toBe(false);
    expect(connectionRegistryPath({}, root)).toBe(path.join(root, ".config", "oms", "vault.json"));
    expect(connectionRegistryPath({ XDG_CONFIG_HOME: "" }, root)).toBe(path.join(root, ".config", "oms", "vault.json"));
  });

  it("accepts a valid v1 pointer and rejects corrupt, unknown, and bad-signature records without writing", async () => {
    const { vaultA, registry, runtime } = await fixture();
    await mkdir(path.dirname(registry), { recursive: true });
    await writeFile(registry, "{not-json", "utf8");
    expect(await reason(readConnectionRegistry(options(registry, runtime)))).toBe("malformed");
    await writeFile(registry, `${JSON.stringify({ version: 1, vault: vaultA, signature: "bad", extra: true })}\n`, "utf8");
    expect(await reason(readConnectionRegistry(options(registry, runtime)))).toBe("unsupported-record");
    await writeFile(registry, `${JSON.stringify({ version: 1, vault: vaultA, signature: "bad" })}\n`, "utf8");
    expect(await reason(readConnectionRegistry(options(registry, runtime)))).toBe("invalid-signature");
    const digest = await writePointer(registry, vaultA);
    const read = await readConnectionRegistry(options(registry, runtime));
    expect(read.state).toBe("v1");
    expect(read.pointer?.digest).toBe(digest);
    expect(read.pointer?.signature).toBe(signatureFor(vaultA));
    expect(existsSync(runtime)).toBe(false);
  });

  it("migrates one verified v1 pointer and preserves an unrelated entry's canonical bytes", async () => {
    const { vaultA, vaultB, registry, runtime } = await fixture();
    const digest = await writePointer(registry, vaultA);
    const migrated = await migrateHostVaultPointer({ expectedDigest: digest, portableVaultId: ID_B, operationId: OP }, options(registry, runtime));
    expect(migrated.completed).toBe(true);
    expect(migrated.crossFilesystemAtomicity).toBe(false);
    const first = await readConnectionRegistry(options(registry, runtime));
    expect(first.registry?.connections[0]).toMatchObject({ connectionId: ID_A, portableVaultId: ID_B, revision: "1" });
    expect(await realpath(first.registry?.connections[0]?.localVaultPath ?? "")).toBe(await realpath(vaultA));
    const added = await upsertVaultConnection({
      expectedDigest: first.registry?.digest ?? "",
      portableVaultId: ID_C,
      localVaultPath: vaultB,
      connectionId: ID_C,
      select: false,
      operationId: "55555555-5555-4555-8555-555555555555",
    }, options(registry, runtime));
    const beforeB = (await readConnectionRegistry(options(registry, runtime))).registry?.connections.find(entry => entry.connectionId === ID_C);
    const second = await readConnectionRegistry(options(registry, runtime));
    await upsertVaultConnection({
      expectedDigest: second.registry?.digest ?? "",
      expectedEntryRevision: "1",
      connectionId: ID_A,
      portableVaultId: ID_B,
      localVaultPath: vaultA,
      select: true,
      operationId: "66666666-6666-4666-8666-666666666666",
    }, options(registry, runtime));
    const after = await readConnectionRegistry(options(registry, runtime));
    const afterB = after.registry?.connections.find(entry => entry.connectionId === ID_C);
    expect(afterB).toEqual(beforeB);
    expect(added.registryDigest).not.toBe(digest);
    const backup = await readFile(path.join(runtime, "connection-updates", "v1", OP, "registry-preimage.bin"));
    expect(backup[0]).toBe(1);
    expect(Buffer.from(backup.subarray(1)).toString("utf8")).toContain(vaultA);
  });

  it("blocks v1 conversion when unknown members prevent lossless mapping and leaves the pointer unchanged", async () => {
    const { vaultA, registry, runtime } = await fixture();
    const raw = `${JSON.stringify({ version: 1, vault: vaultA, signature: signatureFor(vaultA), hostModel: "secret" })}\n`;
    await mkdir(path.dirname(registry), { recursive: true });
    await writeFile(registry, raw, "utf8");
    const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    expect(await reason(migrateHostVaultPointer({ expectedDigest: digest, portableVaultId: ID_B }, options(registry, runtime)))).toBe("unsupported-record");
    expect(await readFile(registry, "utf8")).toBe(raw);
    expect(existsSync(path.join(runtime, "connection-updates"))).toBe(false);
  });

  it("rejects stale registry and entry CAS without changing bytes", async () => {
    const { vaultA, vaultB, registry, runtime } = await fixture();
    const created = await upsertVaultConnection({
      expectedDigest: "sha256:absent",
      portableVaultId: ID_B,
      localVaultPath: vaultA,
      select: true,
      operationId: OP,
    }, options(registry, runtime));
    const before = await readFile(registry);
    expect(await reason(upsertVaultConnection({
      expectedDigest: "sha256:stale",
      expectedEntryRevision: "1",
      connectionId: ID_A,
      portableVaultId: ID_B,
      localVaultPath: vaultB,
      select: true,
    }, options(registry, runtime)))).toBe("stale-cas");
    expect(await reason(upsertVaultConnection({
      expectedDigest: created.registryDigest,
      expectedEntryRevision: "9",
      connectionId: ID_A,
      portableVaultId: ID_B,
      localVaultPath: vaultB,
      select: true,
    }, options(registry, runtime)))).toBe("stale-cas");
    expect(await readFile(registry)).toEqual(before);
  });

  it("conflicts when registry bytes change after backup and retries the same operation without overwriting third-party bytes", async () => {
    const { vaultA, vaultB, registry, runtime } = await fixture();
    const first = await upsertVaultConnection({
      expectedDigest: "sha256:absent",
      portableVaultId: ID_B,
      localVaultPath: vaultA,
      select: true,
      operationId: OP,
    }, options(registry, runtime));
    const external = await upsertVaultConnection({
      expectedDigest: first.registryDigest,
      portableVaultId: ID_C,
      localVaultPath: vaultB,
      connectionId: ID_C,
      select: false,
      operationId: "55555555-5555-4555-8555-555555555555",
    }, options(registry, runtime));
    const thirdParty = await readFile(registry);
    expect(await reason(upsertVaultConnection({
      expectedDigest: first.registryDigest,
      portableVaultId: ID_B,
      localVaultPath: vaultA,
      select: false,
      operationId: "66666666-6666-4666-8666-666666666666",
    }, options(registry, runtime)))).toBe("stale-cas");
    expect(await readFile(registry)).toEqual(thirdParty);
    const replay = await upsertVaultConnection({
      expectedDigest: first.registryDigest,
      portableVaultId: ID_C,
      localVaultPath: vaultB,
      connectionId: ID_C,
      select: false,
      operationId: "55555555-5555-4555-8555-555555555555",
    }, options(registry, runtime));
    expect(replay.registryDigest).toBe(external.registryDigest);
    expect(await readFile(registry)).toEqual(thirdParty);
  });

  it("rejects symlink registry and vault targets and a live lock without PID takeover", async () => {
    const { root, vaultA, registry, runtime } = await fixture();
    const realRegistry = path.join(root, "real-vault.json");
    await mkdir(path.dirname(registry), { recursive: true });
    await writeFile(realRegistry, "{}\n", "utf8");
    await symlink(realRegistry, registry);
    expect(await reason(readConnectionRegistry(options(registry, runtime)))).toBe("unsafe-target");
    await rm(registry);
    const alias = path.join(root, "vault-link");
    await symlink(vaultA, alias);
    const created = await upsertVaultConnection({
      expectedDigest: "sha256:absent",
      portableVaultId: ID_B,
      localVaultPath: alias,
      select: true,
    }, options(registry, runtime));
    const direct = await readConnectionRegistry(options(registry, runtime));
    expect(created.completed).toBe(true);
    expect(direct.registry?.connections[0]?.localVaultPath).toBe(await realpath(vaultA));
    expect(direct.registry?.digest).toBe(created.registryDigest);

    await mkdir(`${registry}.lock`);

    await writeFile(path.join(`${registry}.lock`, "owner.json"), `${JSON.stringify({ pid: process.pid, token: "live" })}\n`);
    expect(await reason(upsertVaultConnection({
      expectedDigest: "sha256:absent",
      portableVaultId: ID_C,
      localVaultPath: vaultA,
      select: false,
    }, options(registry, runtime)))).toBe("locked");
    expect((await stat(registry)).nlink).toBe(1);
  });

  it("preserves unknown v2 members and reports relative XDG input as invalid", async () => {
    const { vaultA, registry, runtime } = await fixture();
    const created = await upsertVaultConnection({
      expectedDigest: "sha256:absent",
      portableVaultId: ID_B,
      localVaultPath: vaultA,
      select: true,
      operationId: OP,
    }, options(registry, runtime));
    const current = JSON.parse(await readFile(registry, "utf8")) as { connections: Array<Record<string, unknown>> };
    const entry = current.connections[0];
    if (entry === undefined) throw new Error("missing entry");
    entry["legacyNote"] = { keep: true };
    const raw = `${JSON.stringify({ ...current, connections: [entry], vendor: ["kept"] })}\n`;
    await writeFile(registry, raw, "utf8");
    const read = await readConnectionRegistry(options(registry, runtime));
    expect(read.registry?.unknown).toEqual({ vendor: ["kept"] });
    expect(read.registry?.connections[0]?.unknown).toEqual({ legacyNote: { keep: true } });
    expect(read.registry?.digest).not.toBe(created.registryDigest);
    expect(() => connectionRegistryPath({ XDG_CONFIG_HOME: "relative" }, "/tmp")).toThrow(ConnectionRegistryError);
  });
  it("retries the same input and operation id after each sealed fault boundary", async () => {
    const boundaries: ConnectionRegistryFault[] = ["after-manifest", "after-backup", "after-registry-rename", "before-receipt"];
    for (const boundary of boundaries) {
      const { vaultA, vaultB, registry, runtime } = await fixture();
      const first = await upsertVaultConnection({
        expectedDigest: "sha256:absent", portableVaultId: ID_B, localVaultPath: vaultA, connectionId: ID_A, select: true,
        operationId: "55555555-5555-4555-8555-555555555555",
      }, options(registry, runtime));
      const input = {
        expectedDigest: first.registryDigest, expectedEntryRevision: "1", connectionId: ID_A, portableVaultId: ID_B,
        localVaultPath: vaultB, select: true, operationId: OP,
      };
      expect(await reason(upsertVaultConnection(input, options(registry, runtime, boundary)))).toBe("injected-fault");
      const recovered = [];
      for (let attempt = 0; attempt < 3; attempt += 1) recovered.push(await upsertVaultConnection(input, options(registry, runtime)));
      expect(new Set(recovered.map(item => item.registryDigest)).size).toBe(1);
      expect(new Set(recovered.map(item => item.inputDigest)).size).toBe(1);
      const after = await readConnectionRegistry(options(registry, runtime));
      expect(await realpath(after.registry?.connections[0]?.localVaultPath ?? "")).toBe(await realpath(vaultB));
    }
  });
  it("reports external change when a completed upsert is restored to its exact preimage", async () => {
    const { vaultA, vaultB, registry, runtime } = await fixture();
    const first = await upsertVaultConnection({
      expectedDigest: "sha256:absent", portableVaultId: ID_B, localVaultPath: vaultA, connectionId: ID_A, select: true,
      operationId: "55555555-5555-4555-8555-555555555555",
    }, options(registry, runtime));
    const preimage = await readFile(registry);
    const input = {
      expectedDigest: first.registryDigest, expectedEntryRevision: "1", connectionId: ID_A, portableVaultId: ID_B,
      localVaultPath: vaultB, select: true, operationId: OP,
    };
    const completed = await upsertVaultConnection(input, options(registry, runtime));
    const receiptPath = path.join(runtime, "connection-updates", "v1", OP, "receipt.json");
    const receipt = await readFile(receiptPath);
    const postimage = await readFile(registry);
    const other = path.join(runtime, "connection-updates", "v1", "55555555-5555-4555-8555-555555555555");
    const otherBefore = await readdir(other);
    await writeFile(registry, preimage);
    const replays = [];
    for (let attempt = 0; attempt < 3; attempt += 1) replays.push(await upsertVaultConnection(input, options(registry, runtime)));
    expect(replays.every(item => item.completed === false && item.pendingReconciliation === true && item.reason === "external-change")).toBe(true);
    expect(replays.every(item => item.registryDigest === first.registryDigest)).toBe(true);
    expect(await readFile(registry)).toEqual(preimage);
    expect(await readFile(receiptPath)).toEqual(receipt);
    expect(await readdir(other)).toEqual(otherBefore);
    expect(postimage.equals(preimage)).toBe(false);
  });
  it("rejects a forged completed receipt without rewriting registry or receipt bytes", async () => {
    const { vaultA, vaultB, registry, runtime } = await fixture();
    const first = await upsertVaultConnection({
      expectedDigest: "sha256:absent", portableVaultId: ID_B, localVaultPath: vaultA, connectionId: ID_A, select: true,
      operationId: "55555555-5555-4555-8555-555555555555",
    }, options(registry, runtime));
    const input = {
      expectedDigest: first.registryDigest, expectedEntryRevision: "1", connectionId: ID_A, portableVaultId: ID_B,
      localVaultPath: vaultB, select: true, operationId: OP,
    };
    await upsertVaultConnection(input, options(registry, runtime));
    const receiptPath = path.join(runtime, "connection-updates", "v1", OP, "receipt.json");
    const persisted = await readFile(receiptPath);
    const forged = `${JSON.stringify({ ...JSON.parse(persisted.toString("utf8")) as Record<string, unknown>, registryDigest: first.registryDigest })}\n`;
    await writeFile(receiptPath, forged);
    const before = await readFile(registry);
    expect(await reason(upsertVaultConnection(input, options(registry, runtime)))).toBe("external-change");
    expect(await readFile(registry)).toEqual(before);
    expect(await readFile(receiptPath, "utf8")).toBe(forged);
  });

  it("does not treat an absent receipt beside a sealed manifest and postimage as proof a completion was lost", async () => {
    const { vaultA, vaultB, registry, runtime } = await fixture();
    const first = await upsertVaultConnection({
      expectedDigest: "sha256:absent", portableVaultId: ID_B, localVaultPath: vaultA, connectionId: ID_A, select: true,
      operationId: "55555555-5555-4555-8555-555555555555",
    }, options(registry, runtime));
    const input = {
      expectedDigest: first.registryDigest, expectedEntryRevision: "1", connectionId: ID_A, portableVaultId: ID_B,
      localVaultPath: vaultB, select: true, operationId: OP,
    };
    await upsertVaultConnection(input, { ...options(registry, runtime), fault: "before-receipt" }).catch(error => {
      expect(error).toBeInstanceOf(ConnectionRegistryError);
    });
    const directory = path.join(runtime, "connection-updates", "v1", OP);
    expect(existsSync(path.join(directory, "receipt.json"))).toBe(false);
    const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as { phase: string };
    expect(manifest.phase).toBe("sealed");
    const recovered = await upsertVaultConnection(input, options(registry, runtime));
    expect(recovered.completed).toBe(true);
    expect(existsSync(path.join(directory, "receipt.json"))).toBe(true);
  });

  it("reports external change when a completed v1 migration is restored to its exact preimage", async () => {
    const { vaultA, registry, runtime } = await fixture();
    const digest = await writePointer(registry, vaultA);
    const preimage = await readFile(registry);
    const input = { expectedDigest: digest, portableVaultId: ID_B, connectionId: ID_A, operationId: OP };
    const completed = await migrateHostVaultPointer(input, options(registry, runtime));
    expect(completed.completed).toBe(true);
    const receiptPath = path.join(runtime, "connection-updates", "v1", OP, "receipt.json");
    const receipt = await readFile(receiptPath);
    await writeFile(registry, preimage);
    const replays = [];
    for (let attempt = 0; attempt < 3; attempt += 1) replays.push(await migrateHostVaultPointer(input, options(registry, runtime)));
    expect(replays.every(item => item.completed === false && item.pendingReconciliation === true && item.reason === "external-change")).toBe(true);
    expect(await readFile(registry)).toEqual(preimage);
    expect(await readFile(receiptPath)).toEqual(receipt);
    expect((await readConnectionRegistry(options(registry, runtime))).state).toBe("v1");
  });

  it("keeps a completed full-registry receipt authoritative after an unrelated entry changes", async () => {
    const { vaultA, vaultB, registry, runtime } = await fixture();
    const input = {
      expectedDigest: "sha256:absent", portableVaultId: ID_B, localVaultPath: vaultA, connectionId: ID_A, select: true, operationId: OP,
    };
    const created = await upsertVaultConnection(input, options(registry, runtime));
    const unchangedA = (await readConnectionRegistry(options(registry, runtime))).registry?.connections[0];
    const receiptPath = path.join(runtime, "connection-updates", "v1", OP, "receipt.json");
    const receipt = await readFile(receiptPath);
    const added = await upsertVaultConnection({
      expectedDigest: created.registryDigest, portableVaultId: ID_C, localVaultPath: vaultB, connectionId: ID_C, select: false,
      operationId: "55555555-5555-4555-8555-555555555555",
    }, options(registry, runtime));
    const afterB = await readFile(registry);
    const replay = await upsertVaultConnection(input, options(registry, runtime));

    expect(replay.completed).toBe(false);
    expect(replay.pendingReconciliation).toBe(true);
    expect(replay.reason).toBe("external-change");
    expect(replay.registryDigest).not.toBe(created.registryDigest);
    expect(await readFile(receiptPath)).toEqual(receipt);
    expect(added.registryDigest).not.toBe(created.registryDigest);

    expect(await readFile(registry)).toEqual(afterB);
    expect((await readConnectionRegistry(options(registry, runtime))).registry?.connections.find(entry => entry.connectionId === ID_A)).toEqual(unchangedA);
  });


  it("rejects an ancestor symlink escape and a hardlinked backup", async () => {
    const { root, vaultA, vaultB, registry, runtime } = await fixture();
    const canonicalRoot = await realpath(root);
    const outside = path.join(canonicalRoot, "outside");
    const linkedParent = path.join(canonicalRoot, "linked-parent");
    await mkdir(outside);
    await symlink(outside, linkedParent);
    const escaped = path.join(linkedParent, "oms", "vault.json");
    expect(await reason(readConnectionRegistry({ registryPath: escaped, runtimeRoot: runtime }))).toBe("unsafe-target");
    expect(existsSync(path.join(outside, "oms"))).toBe(false);
    await upsertVaultConnection({
      expectedDigest: "sha256:absent", portableVaultId: ID_B, localVaultPath: vaultA, select: true, operationId: OP,
    }, options(registry, runtime));
    const nextOperation = "55555555-5555-4555-8555-555555555555";
    const nextBackup = path.join(runtime, "connection-updates", "v1", nextOperation, "registry-preimage.bin");
    await mkdir(path.dirname(nextBackup), { recursive: true });
    await writeFile(nextBackup, "sealed-preimage", "utf8");
    await link(nextBackup, path.join(canonicalRoot, "backup-hardlink"));
    const current = await readConnectionRegistry(options(registry, runtime));
    expect(await reason(upsertVaultConnection({
      expectedDigest: current.registry?.digest ?? "", expectedEntryRevision: "1", connectionId: ID_A, portableVaultId: ID_B,
      localVaultPath: vaultB, select: false, operationId: nextOperation,
    }, options(registry, runtime)))).toBe("unsafe-target");
  });

  it("serializes concurrent writers and preserves the unrelated entry", async () => {
    const { vaultA, vaultB, registry, runtime } = await fixture();
    const first = await upsertVaultConnection({
      expectedDigest: "sha256:absent", portableVaultId: ID_B, localVaultPath: vaultA, connectionId: ID_A, select: true, operationId: OP,
    }, options(registry, runtime));
    const beforeA = (await readConnectionRegistry(options(registry, runtime))).registry?.connections[0];
    const results = await Promise.allSettled([
      upsertVaultConnection({
        expectedDigest: first.registryDigest, portableVaultId: ID_C, localVaultPath: vaultB, connectionId: ID_C, select: false,
        operationId: "55555555-5555-4555-8555-555555555555",
      }, options(registry, runtime)),
      upsertVaultConnection({
        expectedDigest: first.registryDigest, portableVaultId: ID_C, localVaultPath: vaultB, connectionId: ID_C, select: false,
        operationId: "66666666-6666-4666-8666-666666666666",
      }, options(registry, runtime)),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const after = await readConnectionRegistry(options(registry, runtime));
    expect(after.registry?.connections.find(entry => entry.connectionId === ID_A)).toEqual(beforeA);
    expect(after.registry?.connections).toHaveLength(2);
  });
});

describe("vault connection reservation", () => {
  it("reserves a stable id before registration and reuses it across repeat and concurrent calls", async () => {
    const { vaultA, registry, runtime } = await fixture();
    await publishIdentity(vaultA, ID_B);
    const target = { vault: vaultA, source: "explicit" as const };
    const first = await reserveVaultConnection(target, options(registry, runtime));
    const second = await reserveVaultConnection(target, options(registry, runtime));
    const concurrent = await Promise.allSettled([
      reserveVaultConnection(target, options(registry, runtime)),
      reserveVaultConnection(target, options(registry, runtime)),
    ]);
    expect(first).toEqual({ version: 1, connectionId: ID_A, portableVaultId: ID_B, localVaultPath: vaultA, state: "reserved" });
    expect(second).toEqual(first);
    for (const result of concurrent) {
      if (result.status === "fulfilled") expect(result.value).toEqual(first);
      else {
        expect(result.reason).toBeInstanceOf(ConnectionRegistryError);
        expect(result.reason).toMatchObject({ reason: "locked" });
      }
    }
    expect(await reserveVaultConnection(target, options(registry, runtime))).toEqual(first);
    expect(await readConnectionRegistry(options(registry, runtime))).toEqual({ path: registry, state: "missing" });
    expect(existsSync(registry)).toBe(false);
    const stored = JSON.parse(await readFile(reservationFile(runtime, vaultA, ID_B), "utf8")) as Record<string, unknown>;
    expect(stored).toEqual({ version: 1, connectionId: ID_A, portableVaultId: ID_B, localVaultPath: vaultA });
    expect((await stat(reservationFile(runtime, vaultA, ID_B))).mode & 0o077).toBe(0);
  });

  it("registers the reserved id and rejects a conflicting supplied id without rotating it", async () => {
    const { vaultA, registry, runtime } = await fixture();
    await publishIdentity(vaultA, ID_B);
    const reserved = await reserveVaultConnection({ vault: vaultA, source: "vault" }, options(registry, runtime));
    const created = await upsertVaultConnection({
      expectedDigest: "sha256:absent", portableVaultId: ID_B, localVaultPath: vaultA, select: false, operationId: OP,
    }, options(registry, runtime));
    const registered = await readConnectionRegistry(options(registry, runtime));
    expect(registered.registry?.connections[0]?.connectionId).toBe(reserved.connectionId);
    expect(registered.registry?.selectedConnectionId).toBeNull();
    expect(created.registryDigest).toBe(registered.registry?.digest);
    const before = await readFile(registry);
    const digest = registered.registry?.digest ?? "";
    expect(await reason(upsertVaultConnection({
      expectedDigest: digest, portableVaultId: ID_C, localVaultPath: vaultA, connectionId: ID_C, select: false,
    }, options(registry, runtime)))).toBe("identity-conflict");
    expect(await readFile(registry)).toEqual(before);
    expect(JSON.parse(await readFile(reservationFile(runtime, vaultA, ID_B), "utf8"))).toMatchObject({ connectionId: reserved.connectionId });
    const again = await reserveVaultConnection({ vault: vaultA, source: "bridge" }, options(registry, runtime));
    expect(again).toMatchObject({ connectionId: reserved.connectionId, state: "registered" });
  });

  it("keeps distinct ids for two local copies of one portable identity", async () => {
    const { vaultA, vaultB, registry, runtime } = await fixture();
    await publishIdentity(vaultA, ID_B);
    await publishIdentity(vaultB, ID_B);
    const copyA = await reserveVaultConnection({ vault: vaultA, source: "env" }, options(registry, runtime));
    const copyB = await reserveVaultConnection({ vault: vaultB, source: "explicit" }, { ...options(registry, runtime), createId: () => ID_C });
    expect(copyA.connectionId).toBe(ID_A);
    expect(copyB.connectionId).toBe(ID_C);
    expect(copyA.localVaultPath).not.toBe(copyB.localVaultPath);
    expect(copyA.portableVaultId).toBe(ID_B);
    expect(copyB.portableVaultId).toBe(ID_B);
    const samePath = await fixture();
    await publishIdentity(samePath.vaultA, ID_B);
    await upsertVaultConnection({
      expectedDigest: "sha256:absent", portableVaultId: ID_B, localVaultPath: samePath.vaultA, connectionId: ID_A, select: false, operationId: OP,
    }, options(samePath.registry, samePath.runtime));
    await writeFile(path.join(samePath.vaultA, ".oms", "settings.json"), `${JSON.stringify({ version: 1, vaultId: ID_C, templateRoots: ["Templates"] })}\n`);
    const beforeMismatch = await readFile(samePath.registry);
    expect(await reason(reserveVaultConnection({ vault: samePath.vaultA, source: "explicit" }, options(samePath.registry, samePath.runtime)))).toBe("identity-conflict");
    expect(await readFile(samePath.registry)).toEqual(beforeMismatch);
  });

  it("reuses one reservation when the same canonical root is addressed through its real path", async () => {
    const { root, vaultA, registry, runtime } = await fixture();
    await publishIdentity(vaultA, ID_B);
    const alias = path.join(root, "vault-a-alias");
    await symlink(vaultA, alias);
    const reserved = await reserveVaultConnection({ vault: alias, source: "explicit" }, options(registry, runtime));
    expect(reserved.localVaultPath).toBe(await realpath(vaultA));
    const real = await reserveVaultConnection({ vault: await realpath(vaultA), source: "explicit" }, options(registry, runtime));
    expect(real).toEqual(reserved);
    const registryAlias = path.join(root, "registry-link");
    await symlink(registry, registryAlias);
    expect(await reason(readConnectionRegistry({ registryPath: registryAlias, runtimeRoot: runtime }))).toBe("unsafe-target");
    expect(await readdir(path.join(runtime, "connection-reservations", "v1"))).toHaveLength(1);
  });
  it("canonicalizes an admitted public vault leaf alias onto the existing identity", async () => {
    const { root, vaultA, registry, runtime } = await fixture();
    await publishIdentity(vaultA, ID_B);
    const alias = path.join(root, "vault-a-leaf");
    await symlink(vaultA, alias);
    const reserved = await reserveVaultConnection({ vault: alias, source: "explicit" }, options(registry, runtime));
    const repeated = await reserveVaultConnection({ vault: vaultA, source: "explicit" }, options(registry, runtime));
    expect(reserved.localVaultPath).toBe(await realpath(vaultA));
    expect(repeated).toEqual(reserved);
    expect(await readdir(path.join(runtime, "connection-reservations", "v1"))).toHaveLength(1);
    const created = await upsertVaultConnection({
      expectedDigest: "sha256:absent", portableVaultId: ID_B, localVaultPath: alias, select: true, operationId: OP,
    }, options(registry, runtime));
    expect(created.completed).toBe(true);
    expect((await readConnectionRegistry(options(registry, runtime))).registry?.connections[0]?.localVaultPath).toBe(await realpath(vaultA));
    const registryAlias = path.join(root, "registry-link");
    await symlink(registry, registryAlias);
    expect(await reason(readConnectionRegistry({ registryPath: registryAlias, runtimeRoot: runtime }))).toBe("unsafe-target");
    const privateAlias = path.join(root, "runtime-link");
    await symlink(runtime, privateAlias);
    expect(await reason(reserveVaultConnection({ vault: alias, source: "explicit" }, { registryPath: registry, runtimeRoot: privateAlias, createId: () => ID_A }))).toBe("unsafe-target");
  });

  it("reserves explicit A without reading or converting v1 pointer B", async () => {
    const { vaultA, vaultB, registry, runtime } = await fixture();
    await publishIdentity(vaultA, ID_B);
    await writePointer(registry, vaultB);
    const pointer = await readFile(registry, "utf8");
    const secret = path.join(vaultB, "must-not-read.txt");
    await writeFile(secret, "secret-b", "utf8");
    const reserved = await reserveVaultConnection({ vault: vaultA, source: "explicit" }, options(registry, runtime));
    expect(reserved).toMatchObject({ portableVaultId: ID_B, localVaultPath: vaultA, state: "reserved" });
    expect(await readFile(registry, "utf8")).toBe(pointer);
    expect(await readFile(secret, "utf8")).toBe("secret-b");
    expect((await readConnectionRegistry(options(registry, runtime))).state).toBe("v1");
    expect(existsSync(path.join(vaultB, ".oms"))).toBe(false);
  });

  it("preserves unrelated registry bytes, unknowns, and selection while reserving another vault", async () => {
    const { vaultA, vaultB, registry, runtime } = await fixture();
    await publishIdentity(vaultA, ID_B);
    await publishIdentity(vaultB, ID_C);
    await upsertVaultConnection({
      expectedDigest: "sha256:absent", portableVaultId: ID_B, localVaultPath: vaultA, connectionId: ID_A, select: true, operationId: OP,
    }, options(registry, runtime));
    const current = JSON.parse(await readFile(registry, "utf8")) as { connections: Array<Record<string, unknown>> };
    const entry = current.connections[0];
    if (entry === undefined) throw new Error("missing entry");
    entry["legacyNote"] = { keep: true };
    const raw = `${JSON.stringify({ ...current, connections: [entry], vendor: ["kept"] })}\n`;
    await writeFile(registry, raw, "utf8");
    const reserved = await reserveVaultConnection({ vault: vaultB, source: "explicit" }, options(registry, runtime));
    expect(reserved.state).toBe("reserved");
    expect(await readFile(registry, "utf8")).toBe(raw);
    const read = await readConnectionRegistry(options(registry, runtime));
    expect(read.registry?.selectedConnectionId).toBe(ID_A);
    expect(read.registry?.unknown).toEqual({ vendor: ["kept"] });
    expect(read.registry?.connections).toHaveLength(1);
  });

  it("rejects missing or invalid settings, cwd, and unknown sources before creating storage", async () => {
    const { vaultA, registry, runtime } = await fixture();
    expect(await reason(reserveVaultConnection({ vault: vaultA, source: "explicit" }, options(registry, runtime)))).toBe("missing-state");
    expect(existsSync(runtime)).toBe(false);
    expect(existsSync(path.dirname(registry))).toBe(false);
    await publishIdentity(vaultA, "not-a-uuid");
    expect(await reason(reserveVaultConnection({ vault: vaultA, source: "explicit" }, options(registry, runtime)))).toBe("malformed");
    expect(existsSync(runtime)).toBe(false);
    await writeFile(path.join(vaultA, ".oms", "settings.json"), `${JSON.stringify({ version: 1, vaultId: ID_B, templateRoots: ["Templates"] })}\n`);
    expect(await reason(reserveVaultConnection({ vault: vaultA, source: "cwd" }, options(registry, runtime)))).toBe("unsafe-target");
    expect(await reason(reserveVaultConnection({ vault: vaultA, source: "unknown" as "explicit" }, options(registry, runtime)))).toBe("unsafe-target");
    expect(existsSync(path.join(runtime, "connection-reservations"))).toBe(false);
  });

  it("rejects a corrupt, foreign, or hardlinked reservation without overwriting it", async () => {
    const { root, vaultA, registry, runtime } = await fixture();
    await publishIdentity(vaultA, ID_B);
    const file = reservationFile(runtime, vaultA, ID_B);
    await mkdir(runtime, { mode: 0o700 });
    await mkdir(path.dirname(path.dirname(file)), { mode: 0o700 });
    await mkdir(path.dirname(file), { mode: 0o700 });
    await writeFile(file, "{not-json", { encoding: "utf8", mode: 0o600 });
    expect(await reason(reserveVaultConnection({ vault: vaultA, source: "explicit" }, options(registry, runtime)))).toBe("malformed");
    expect(await readFile(file, "utf8")).toBe("{not-json");
    const foreign = `${JSON.stringify({ version: 1, connectionId: ID_C, portableVaultId: ID_C, localVaultPath: vaultA })}\n`;
    await writeFile(file, foreign, { encoding: "utf8", mode: 0o600 });
    expect(await reason(reserveVaultConnection({ vault: vaultA, source: "explicit" }, options(registry, runtime)))).toBe("identity-conflict");
    expect(await readFile(file, "utf8")).toBe(foreign);
    await chmod(file, 0o644);
    expect(await reason(reserveVaultConnection({ vault: vaultA, source: "explicit" }, options(registry, runtime)))).toBe("unsafe-target");
    await chmod(file, 0o600);
    await link(file, path.join(root, "reservation-hardlink"));
    expect(await reason(reserveVaultConnection({ vault: vaultA, source: "explicit" }, options(registry, runtime)))).toBe("unsafe-target");
    expect(await readFile(file, "utf8")).toBe(foreign);
  });

  it("rejects registry or runtime storage inside the selected vault before creating directories", async () => {
    const { root, vaultA, registry } = await fixture();
    await publishIdentity(vaultA, ID_B);
    const inside = path.join(vaultA, "runtime");
    const before = await readFile(path.join(vaultA, ".oms", "settings.json"));
    expect(await reason(reserveVaultConnection({ vault: vaultA, source: "explicit" }, { registryPath: registry, runtimeRoot: inside, createId: () => ID_A }))).toBe("unsafe-target");
    expect(existsSync(inside)).toBe(false);
    expect(existsSync(path.join(vaultA, "connection-reservations"))).toBe(false);
    expect(await reason(reserveVaultConnection({ vault: vaultA, source: "explicit" }, { registryPath: path.join(vaultA, "vault.json"), runtimeRoot: path.join(root, "runtime"), createId: () => ID_A }))).toBe("unsafe-target");
    expect(existsSync(path.join(vaultA, "vault.json"))).toBe(false);
    expect(existsSync(path.join(root, "runtime"))).toBe(false);
    expect(await readFile(path.join(vaultA, ".oms", "settings.json"))).toEqual(before);
  });

  it("does not create a reservation when the selected root has no usable ancestor", async () => {
    const { root, registry, runtime } = await fixture();
    const missing = path.join(root, "missing-vault");
    expect(await reason(reserveVaultConnection({ vault: missing, source: "explicit" }, options(registry, runtime)))).toBe("invalid-path");
    expect(existsSync(path.join(runtime, "connection-reservations"))).toBe(false);
    expect(existsSync(path.dirname(registry))).toBe(false);
  });
});
