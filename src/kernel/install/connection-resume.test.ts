import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { serializeVaultSettings } from "../vault/settings.js";
import {
  commitConnection,
  ConnectionCoordinatorError,
  prepareConnection,
  resumeConnection,
  settingsPublicationRequest,
  type ConnectionCommitResult,
  type ConnectionCoordinatorFault,
  type PreparedConnection,
} from "./connection-coordinator.js";
import { connectionRegistryPath, readConnectionRegistry, reserveVaultConnection, upsertVaultConnection } from "./connection-registry.js";
import { readProjectConnection } from "./project-connection.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
let sequence = 0;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function operationId(): string {
  sequence += 1;
  return `66666666-6666-4666-8666-${String(sequence).padStart(12, "0")}`;
}

function transactionId(index: number): string {
  return `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`;
}

async function fixture(): Promise<{ readonly root: string; readonly vault: string; readonly other: string; readonly project: string; readonly registry: string; readonly runtime: string; readonly home: string }> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "oms-connection-resume-")));
  roots.push(root);
  const vault = path.join(root, "vault");
  const other = path.join(root, "other");
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  await Promise.all([mkdir(vault), mkdir(other), mkdir(project), mkdir(home)]);
  return { root, vault, other, project, registry: connectionRegistryPath({ XDG_CONFIG_HOME: path.join(root, "xdg") }, home), runtime: path.join(root, "runtime"), home };
}

function options(registry: string, runtime: string, home: string, fault?: ConnectionCoordinatorFault | "after-plan") {
  const seen = new Set<string>();
  const publicationFault = fault === "after-plan" ? (point: string) => {
    seen.add(point);
    if (point === "after-plan") throw new ConnectionCoordinatorError("injected-fault", "Injected native fault at after-plan.");
  } : undefined;
  return { registryPath: registry, runtimeRoot: runtime, homeDir: home, env: { HOME: home, XDG_CONFIG_HOME: path.dirname(path.dirname(registry)) }, createId: () => ID_A, ...(fault !== undefined && fault !== "after-plan" ? { coordinatorFault: fault } : {}), ...(publicationFault === undefined ? {} : { publicationFault }), seen };
}

async function publish(vault: string, vaultId = ID_A): Promise<void> {
  await mkdir(path.join(vault, ".oms"), { recursive: true });
  await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId }));
}

function intentFile(runtime: string, id: string): string {
  return path.join(runtime, "connection-coordinator", "v1", id, "intent.json");
}

async function bytesAt(file: string): Promise<Buffer | undefined> {
  try { return await readFile(file); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}

async function snapshot(vault: string, project: string, registry: string, runtime: string, id: string) {
  const intent = await bytesAt(intentFile(runtime, id));
  return {
    settings: await bytesAt(path.join(vault, ".oms", "settings.json")),
    registry: await bytesAt(registry),
    links: await bytesAt(path.join(project, ".oms", "links.yaml")),
    intent,
  };
}

async function prepare(vault: string, registry: string, runtime: string, home: string, project?: string, publication = true, select = false): Promise<PreparedConnection> {
  const id = operationId();
  return prepareConnection({
    operationId: id,
    target: { vault, source: "explicit" },
    publication: publication ? settingsPublicationRequest(transactionId(sequence), ID_A) : null,
    select,
    ...(project === undefined ? {} : { project: { root: project, scope: ["notes"] } }),
  }, options(registry, runtime, home));
}

async function register(vault: string, registry: string, runtime: string, home: string): Promise<void> {
  await publish(vault);
  const reserved = await reserveVaultConnection({ vault, source: "explicit" }, options(registry, runtime, home));
  await upsertVaultConnection({ expectedDigest: "sha256:absent", connectionId: reserved.connectionId, portableVaultId: reserved.portableVaultId, localVaultPath: reserved.localVaultPath, select: false, operationId: operationId() }, options(registry, runtime, home));
}

async function seal(prepared: PreparedConnection, registry: string, runtime: string, home: string, fault: ConnectionCoordinatorFault | "after-plan"): Promise<ConnectionCommitResult> {
  const configured = options(registry, runtime, home, fault);
  const staged = await commitConnection(prepared, prepared.digest, configured);
  expect([staged.vault.code, staged.global.code, staged.project.code, staged.reservationDiagnostic?.code]).toContain("injected-fault");
  if (fault === "after-plan") expect([...configured.seen]).toEqual(["after-plan"]);
  return staged;
}

function committed(value: Awaited<ReturnType<typeof resumeConnection>>): ConnectionCommitResult {
  if ("state" in value) throw new Error(value.state);
  return value;
}

function keys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keys(item, found);
  else if (typeof value === "object" && value !== null) for (const [key, item] of Object.entries(value)) { found.add(key); keys(item, found); }
  return found;
}

describe("generic connection cold resume", () => {
  it.each(["after-intent", "after-vault-publication", "after-reservation", "after-global-upsert", "after-project-publication"] as const)("cold-resumes %s from a fresh settings vault", async fault => {
    const { vault, project, registry, runtime, home } = await fixture();
    const prepared = await prepare(vault, registry, runtime, home, project);
    const staged = await seal(prepared, registry, runtime, home, fault);
    expect(staged.vault.state).toBe(fault === "after-intent" ? "pending" : "complete");
    const before = await snapshot(vault, project, registry, runtime, prepared.operationId);
    const resumed = committed(await resumeConnection({ operationId: prepared.operationId, target: { vault, source: "explicit" } }, prepared.digest, options(registry, runtime, home)));
    expect(resumed).toMatchObject({ planDigest: prepared.digest, vault: { state: "complete" }, global: { state: "complete", receipt: { completed: true } }, project: { state: "complete", receipt: { completed: true } } });
    const after = await snapshot(vault, project, registry, runtime, prepared.operationId);
    expect(after.intent).toEqual(before.intent);
    if (fault !== "after-intent") expect(after.settings).toEqual(before.settings);
    expect(await readConnectionRegistry(options(registry, runtime, home))).toMatchObject({ state: "v2" });
    expect(await readProjectConnection(project)).toMatchObject({ state: "v2" });
  });

  it("recovers a reached native after-plan fault from a fresh built child", async () => {
    const { vault, project, registry, runtime, home } = await fixture();
    const prepared = await prepare(vault, registry, runtime, home, project);
    await seal(prepared, registry, runtime, home, "after-plan");
    const before = await snapshot(vault, project, registry, runtime, prepared.operationId);
    expect(before.settings).toBeUndefined();
    const childHome = await mkdtemp(path.join(tmpdir(), "oms-connection-resume-child-"));
    roots.push(childHome);
    const child = execFileSync(process.execPath, ["--input-type=module", "-e", "const { resumeConnection } = await import(process.env.OMS_CHILD_COORDINATOR); const result = await resumeConnection({ operationId: process.env.OMS_CHILD_OP, target: { vault: process.env.OMS_CHILD_VAULT, source: 'explicit' } }, process.env.OMS_CHILD_DIGEST, { registryPath: process.env.OMS_CHILD_REGISTRY, runtimeRoot: process.env.OMS_RUNTIME_ROOT, homeDir: process.env.HOME, createId: () => process.env.OMS_CHILD_ID }); if ('state' in result) throw new Error(result.state); process.stdout.write(JSON.stringify({ vault: result.vault.state, global: result.global.state, project: result.project.state, digest: result.planDigest }));"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: childHome, XDG_CONFIG_HOME: path.join(childHome, ".config"), XDG_CACHE_HOME: path.join(childHome, ".cache"), OMS_RUNTIME_ROOT: runtime, OMS_CHILD_COORDINATOR: fileURLToPath(new URL("../../../dist/kernel/install/connection-coordinator.js", import.meta.url)), OMS_CHILD_VAULT: vault, OMS_CHILD_OP: prepared.operationId, OMS_CHILD_DIGEST: prepared.digest, OMS_CHILD_REGISTRY: registry, OMS_CHILD_ID: ID_A },
    });
    expect(JSON.parse(child)).toEqual({ vault: "complete", global: "complete", project: "complete", digest: prepared.digest });
    const after = await snapshot(vault, project, registry, runtime, prepared.operationId);
    expect(after.settings?.toString("utf8")).toBe(serializeVaultSettings({ version: 1, vaultId: ID_A }));
  });

  it("resumes a registered no-publication project without rewriting settings", async () => {
    const { vault, project, registry, runtime, home } = await fixture();
    await register(vault, registry, runtime, home);
    const prepared = await prepare(vault, registry, runtime, home, project, false, true);
    expect(prepared.identityPreview).toEqual({ state: "registered", connectionId: ID_A });
    expect(prepared.input.target.source).toBe("explicit");
    const staged = await seal(prepared, registry, runtime, home, "after-intent");
    expect(staged.vault.state).toBe("not-requested");
    const before = await readFile(path.join(vault, ".oms", "settings.json"));
    const resumed = committed(await resumeConnection({ operationId: prepared.operationId, target: { vault, source: "explicit" } }, prepared.digest, options(registry, runtime, home)));
    expect(resumed).toMatchObject({ vault: { state: "not-requested" }, global: { state: "complete" }, project: { state: "complete" } });
    expect(await readFile(path.join(vault, ".oms", "settings.json"))).toEqual(before);
  });

  it("replays receipts and rejects tampered or omitted approval material before effects", async () => {
    const { vault, other, project, registry, runtime, home } = await fixture();
    const prepared = await prepare(vault, registry, runtime, home, project, true, true);
    const completed = await commitConnection(prepared, prepared.digest, options(registry, runtime, home));
    expect(completed.global.receipt?.completed).toBe(true);
    expect(completed.project.receipt?.completed).toBe(true);
    const before = await snapshot(vault, project, registry, runtime, prepared.operationId);
    const replay = committed(await resumeConnection({ operationId: prepared.operationId, target: { vault, source: "explicit" } }, prepared.digest, options(registry, runtime, home)));
    expect(replay.global.receipt).toEqual(completed.global.receipt);
    expect(replay.project.receipt).toEqual(completed.project.receipt);
    expect(await snapshot(vault, project, registry, runtime, prepared.operationId)).toEqual(before);
    const parsed = JSON.parse((before.intent ?? Buffer.from("")).toString("utf8")) as { approvalBinding: { publication: { evidence: unknown[] } } };
    expect(keys(parsed).has("base64")).toBe(false);
    expect(keys(parsed).has("bytes")).toBe(false);
    expect(keys(parsed).has("content")).toBe(false);
    expect(parsed.approvalBinding.publication.evidence).toEqual([]);
    const file = intentFile(runtime, prepared.operationId);
    const restore = async () => writeFile(file, before.intent ?? "");
    const tamper = async (mutate: (value: { planDigest: string; approvalBinding: Record<string, unknown> }) => void) => {
      const value = JSON.parse((before.intent ?? Buffer.from("")).toString("utf8")) as { planDigest: string; approvalBinding: Record<string, unknown> };
      mutate(value);
      await writeFile(file, `${JSON.stringify(value)}\n`);
    };
    await tamper(value => { value.planDigest = `sha256:${"ab".repeat(32)}`; });
    await expect(resumeConnection({ operationId: prepared.operationId, target: { vault, source: "explicit" } }, prepared.digest, options(registry, runtime, home))).rejects.toMatchObject({ code: "approval-mismatch" });
    await restore();
    await tamper(value => { value.approvalBinding.target = { ...(value.approvalBinding.target as object), source: "env" }; });
    await expect(resumeConnection({ operationId: prepared.operationId, target: { vault, source: "explicit" } }, prepared.digest, options(registry, runtime, home))).rejects.toThrow(ConnectionCoordinatorError);
    await restore();
    for (const key of ["filesystemBindingDigest", "target", "publication", "identityPreview", "expectedRegistryDigest", "canonicalTarget", "project", "select", "blockers"]) {
      await tamper(value => { delete value.approvalBinding[key]; });
      await expect(resumeConnection({ operationId: prepared.operationId, target: { vault, source: "explicit" } }, prepared.digest, options(registry, runtime, home))).rejects.toThrow(ConnectionCoordinatorError);
      await restore();
    }
    await writeFile(registry, `${await readFile(registry, "utf8")} `);
    await expect(resumeConnection({ operationId: prepared.operationId, target: { vault, source: "explicit" } }, prepared.digest, options(registry, runtime, home))).resolves.toMatchObject({ global: { state: "pending", code: "external-change" } });
    await writeFile(registry, before.registry ?? "");
    await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: "99999999-9999-4999-8999-999999999999" }));
    const changedSettings = await snapshot(vault, project, registry, runtime, prepared.operationId);
    await expect(resumeConnection({ operationId: prepared.operationId, target: { vault, source: "explicit" } }, prepared.digest, options(registry, runtime, home))).resolves.toMatchObject({ vault: { state: "blocked", code: "publication-blocked" }, global: { state: "unattempted" } });
    expect(await snapshot(vault, project, registry, runtime, prepared.operationId)).toEqual(changedSettings);
    await writeFile(path.join(vault, ".oms", "settings.json"), before.settings ?? "");
    await expect(resumeConnection({ operationId: prepared.operationId, target: { vault: other, source: "explicit" } }, prepared.digest, options(registry, runtime, home))).rejects.toMatchObject({ code: "external-change" });
    expect(await snapshot(vault, project, registry, runtime, prepared.operationId)).toMatchObject({ intent: before.intent, settings: before.settings, links: before.links });
  });

  it("resumes without vault-side plan state, requires preparation for evidence, and blocks changed settings", async () => {
    const missing = await fixture();
    const prepared = await prepare(missing.vault, missing.registry, missing.runtime, missing.home, missing.project);
    await seal(prepared, missing.registry, missing.runtime, missing.home, "after-intent");
    expect(await bytesAt(path.join(missing.vault, ".oms", "settings.json"))).toBeUndefined();
    const resumed = committed(await resumeConnection({ operationId: prepared.operationId, target: { vault: missing.vault, source: "explicit" } }, prepared.digest, options(missing.registry, missing.runtime, missing.home)));
    expect(resumed).toMatchObject({ vault: { state: "complete" }, project: { state: "complete", receipt: { completed: true } } });
    expect(await readdir(path.join(missing.vault, ".oms"))).toEqual(["settings.json"]);

    const evidenced = await fixture();
    const evidence = await prepareConnection({ operationId: operationId(), target: { vault: evidenced.vault, source: "explicit" }, publication: { ...settingsPublicationRequest(transactionId(sequence), ID_A), evidence: [{ name: "review", bytes: Buffer.from("sentinel-evidence-body") }] }, select: false, project: { root: evidenced.project, scope: ["notes"] } }, options(evidenced.registry, evidenced.runtime, evidenced.home));
    expect(evidence.blockers).toEqual([]);
    await seal(evidence, evidenced.registry, evidenced.runtime, evidenced.home, "after-intent");
    const evidenceIntent = JSON.parse(await readFile(intentFile(evidenced.runtime, evidence.operationId), "utf8")) as unknown;
    expect(JSON.stringify(evidenceIntent)).not.toContain("sentinel-evidence-body");
    expect(keys(evidenceIntent).has("base64")).toBe(false);
    const evidenceBefore = await snapshot(evidenced.vault, evidenced.project, evidenced.registry, evidenced.runtime, evidence.operationId);
    await expect(resumeConnection({ operationId: evidence.operationId, target: { vault: evidenced.vault, source: "explicit" } }, evidence.digest, options(evidenced.registry, evidenced.runtime, evidenced.home))).resolves.toMatchObject({ state: "preparation-required" });
    expect(await snapshot(evidenced.vault, evidenced.project, evidenced.registry, evidenced.runtime, evidence.operationId)).toEqual(evidenceBefore);

    const damaged = await fixture();
    const later = await prepare(damaged.vault, damaged.registry, damaged.runtime, damaged.home, damaged.project);
    await seal(later, damaged.registry, damaged.runtime, damaged.home, "after-plan");
    const settingsFile = path.join(damaged.vault, ".oms", "settings.json");
    const foreign = serializeVaultSettings({ version: 1, vaultId: "99999999-9999-4999-8999-999999999999" });
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, foreign);
    await expect(resumeConnection({ operationId: later.operationId, target: { vault: damaged.vault, source: "explicit" } }, later.digest, options(damaged.registry, damaged.runtime, damaged.home))).resolves.toMatchObject({ vault: { state: "blocked", code: "publication-blocked" } });
    expect(await snapshot(damaged.vault, damaged.project, damaged.registry, damaged.runtime, later.operationId)).toMatchObject({ settings: Buffer.from(foreign), registry: undefined, links: undefined });
    await rm(settingsFile);
    const predecessor = JSON.stringify({ transactionId: "88888888-8888-4888-8888-888888888888", status: "complete" });
    await writeFile(path.join(damaged.vault, ".oms", "unrelated.json"), predecessor);
    const recovered = committed(await resumeConnection({ operationId: later.operationId, target: { vault: damaged.vault, source: "explicit" } }, later.digest, options(damaged.registry, damaged.runtime, damaged.home)));
    expect(recovered).toMatchObject({ vault: { state: "complete" }, project: { state: "complete" } });
    expect(await readFile(settingsFile, "utf8")).toBe(serializeVaultSettings({ version: 1, vaultId: ID_A }));
    expect(await readFile(path.join(damaged.vault, ".oms", "unrelated.json"), "utf8")).toBe(predecessor);
  });
});
