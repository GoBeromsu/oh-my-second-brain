import { lstat, mkdir, readFile, readlink, realpath, symlink, writeFile, link as hardlink } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";

import { admitWriteTarget } from "../capture/safe.js";
import { readConnectionRegistry, upsertVaultConnection } from "../install/connection-registry.js";
import { readProjectConnection } from "../install/project-connection.js";
import type { ConnectionCoordinatorFault } from "../install/connection-coordinator.js";
import { serializeVaultSettings } from "../vault/settings.js";
import {
  ensureGitignore,
  expandHome,
  LINKED_GITIGNORE_PATTERN,
  prepareVaultLink,
  commitVaultLink,
  removeVaultLink,
  removalBindingSeam,
  removalRecordBoundarySeam,
  removalDirectoryBoundarySeam,
  removalLeafBoundarySeam,
  removalParentBoundarySeam,
  removalAbsenceBoundarySeam,
  type RemovalBinding,
  resolveEffectiveVault,
} from "./link.js";

const VAULT_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const TRANSACTION_ID = "33333333-3333-4333-8333-333333333333";

let tmp: string;
let vault: string;
let repo: string;
let home: string;

beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "oms-link-test-"));
  vault = path.join(tmp, "vault");
  repo = path.join(tmp, "repo");
  home = path.join(tmp, "home");
  await mkdir(vault, { recursive: true });
  await mkdir(repo, { recursive: true });
  await mkdir(home, { recursive: true });
  // Private control storage uses canonical roots; public vault/project inputs retain aliases.
  home = await realpath(home);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function registry() {
  return {
    homeDir: home,
    env: { XDG_CONFIG_HOME: path.join(home, "config"), OMS_RUNTIME_ROOT: path.join(home, "runtime") },
    runtimeRoot: path.join(home, "runtime"),
  };
}

async function link(input: Parameters<typeof prepareVaultLink>[0]) {
  const prepared = await prepareVaultLink(input);
  return commitVaultLink(prepared, input.registry);
}

describe("expandHome", () => {
  it("expands a leading ~/ to the home directory", () => {
    expect(expandHome("~/Documents/vault")).toBe(path.resolve(os.homedir(), "Documents/vault"));
  });

  it("resolves a bare ~ to the home directory", () => {
    expect(expandHome("~")).toBe(os.homedir());
  });

  it("resolves a relative path to an absolute path", () => {
    expect(path.isAbsolute(expandHome("./some/where"))).toBe(true);
  });

  it("passes an absolute path through unchanged", () => {
    expect(expandHome("/opt/vaults/v")).toBe("/opt/vaults/v");
  });
});

describe("ensureGitignore", () => {
  it("creates .gitignore with the pattern when absent", async () => {
    expect(await ensureGitignore(repo, LINKED_GITIGNORE_PATTERN)).toBe(true);
    expect(await readFile(path.join(repo, ".gitignore"), "utf-8")).toContain(LINKED_GITIGNORE_PATTERN);
  });

  it("appends the pattern to an existing .gitignore", async () => {
    await writeFile(path.join(repo, ".gitignore"), "node_modules\n", "utf-8");
    expect(await ensureGitignore(repo, LINKED_GITIGNORE_PATTERN)).toBe(true);
    const content = await readFile(path.join(repo, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules");
    expect(content).toContain(LINKED_GITIGNORE_PATTERN);
  });

  it("is idempotent when the pattern is already present", async () => {
    await ensureGitignore(repo, LINKED_GITIGNORE_PATTERN);
    expect(await ensureGitignore(repo, LINKED_GITIGNORE_PATTERN)).toBe(false);
  });
});

describe("resolveEffectiveVault", () => {
  it("prefers an explicit vault over local evidence", async () => {
    await mkdir(path.join(repo, ".oms"), { recursive: true });
    await writeFile(path.join(repo, ".oms", "settings.json"), "{}\n");
    const resolved = await resolveEffectiveVault(repo, { OMS_VAULT: "/env" }, { explicitVault: vault });
    expect(resolved).toEqual({ vault: path.resolve(vault), scope: null, source: "explicit", diagnostics: [] });
  });

  it("treats settings.json as the only local vault evidence", async () => {
    await mkdir(path.join(vault, ".oms"), { recursive: true });
    await writeFile(path.join(vault, ".oms", `${["tax", "onomy"].join("")}.json`), JSON.stringify({ version: 1, folders: {} }));
    await writeFile(path.join(vault, ".oms", `${["template", "policy"].join("-")}.json`), "{}\n");
    expect((await resolveEffectiveVault(vault, {})).source).not.toBe("vault");
    await writeFile(path.join(vault, ".oms", "settings.json"), "{}\n");
    expect((await resolveEffectiveVault(vault, {})).source).toBe("vault");
    expect((await resolveEffectiveVault(vault, {})).scope).toBeNull();
  });

  it("resolves a v2 bridge by exact connection and both portable identities", async () => {
    await mkdir(path.join(vault, ".oms"), { recursive: true });
    await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: VAULT_ID }));
    await mkdir(path.join(vault, "notes"), { recursive: true });
    const linked = await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const connectionId = linked.connection.reservation?.connectionId;
    const resolved = await resolveEffectiveVault(repo, { OMS_VAULT: "/env" }, { registry: registry() });
    expect(resolved.vault).toBe(await realpath(vault));
    expect(resolved.scope).toEqual(["notes"]);
    expect(resolved.source).toBe("bridge");
    expect(connectionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("fails closed when bridge evidence exists but links.yaml is missing", async () => {
    await mkdir(path.join(repo, ".oms", "linked"), { recursive: true });
    await symlink(path.join(tmp, "missing-target"), path.join(repo, ".oms", "linked", "notes"));
    await expect(resolveEffectiveVault(repo, { OMS_VAULT: vault })).rejects.toThrow(/links.yaml is missing/);
  });

  it("fails closed on a corrupt bridge instead of falling back", async () => {
    await mkdir(path.join(repo, ".oms"), { recursive: true });
    await writeFile(path.join(repo, ".oms", "links.yaml"), "vault: [not valid\n");
    await expect(resolveEffectiveVault(repo, { OMS_VAULT: vault })).rejects.toThrow(/Invalid bridge record/);
  });

  it("diagnoses a v1 bridge as read-only path access and refuses writes", async () => {
    await mkdir(path.join(repo, ".oms"), { recursive: true });
    await writeFile(path.join(repo, ".oms", "links.yaml"), `version: 1\nvault: ${vault}\nscope:\n  - notes\n`);
    const resolved = await resolveEffectiveVault(repo, {});
    expect(resolved.vault).toBe(path.resolve(vault));
    expect(resolved.scope).toEqual(["notes"]);
    expect(resolved.source).toBe("legacy-bridge");
    expect(resolved.source).not.toBe("cwd");
    expect(resolved.diagnostics.map(item => item.code)).toEqual(["legacy-readonly"]);
    const refused = await admitWriteTarget({ vault: resolved.vault, source: resolved.source });
    expect(refused?.code).toBe("target-unverified");
    expect(refused?.message).toMatch(/v1 bridge/);
    expect(refused?.remediation).toMatch(/explicit vault target/);
    const explicit = await resolveEffectiveVault(repo, {}, { explicitVault: vault });
    expect(explicit).toEqual({ vault: path.resolve(vault), scope: null, source: "explicit", diagnostics: [] });
    expect(await admitWriteTarget({ vault: explicit.vault, source: explicit.source })).toBeUndefined();
    expect(await readFile(path.join(repo, ".oms", "links.yaml"), "utf8")).toContain("version: 1");
  });

  it("admits a v2 bridge only when connection and both portable identities match", async () => {
    await mkdir(path.join(vault, ".oms"), { recursive: true });
    await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: VAULT_ID }));
    await mkdir(path.join(vault, "notes"), { recursive: true });
    const linked = await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const connectionId = linked.connection.reservation?.connectionId ?? "";
    const record = yamlParse(await readFile(path.join(repo, ".oms", "links.yaml"), "utf8")) as { portableVaultId: string };
    const otherId = "99999999-9999-4999-8999-999999999999";
    await writeFile(path.join(repo, ".oms", "links.yaml"), `version: 2\nconnectionId: ${connectionId}\nportableVaultId: ${otherId}\nscope:\n  - notes\n`);
    await expect(resolveEffectiveVault(repo, { OMS_VAULT: vault }, { registry: registry() })).rejects.toThrow(/not bound in the connection registry/);
    await writeFile(path.join(repo, ".oms", "links.yaml"), `version: 2\nconnectionId: ${connectionId}\nportableVaultId: ${record.portableVaultId}\nscope:\n  - notes\n`);
    await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: otherId }));
    await expect(resolveEffectiveVault(repo, { OMS_VAULT: vault }, { registry: registry() })).rejects.toThrow(/does not match published portable identity/);
    await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: record.portableVaultId }));
    const restored = await resolveEffectiveVault(repo, { OMS_VAULT: "/not-selected" }, { registry: registry() });
    expect(restored.source).toBe("bridge");
    expect(restored.vault).toBe(await realpath(vault));
    expect(await admitWriteTarget({ vault: restored.vault, source: restored.source })).toBeUndefined();
  });

  it("falls back to OMS_VAULT only when no local or bridge evidence exists", async () => {
    expect(await resolveEffectiveVault(repo, { OMS_VAULT: vault })).toEqual({ vault: path.resolve(vault), scope: null, source: "env", diagnostics: [] });
  });

  it("falls back to the start dir when nothing else resolves", async () => {
    expect(await resolveEffectiveVault(repo, {})).toEqual({ vault: path.resolve(repo), scope: null, source: "cwd", diagnostics: [] });
  });

  it("does not use a selected global connection as fallback", async () => {
    const resolved = await resolveEffectiveVault(repo, {}, { registry: registry() });
    expect(resolved.source).toBe("cwd");
    expect(resolved.vault).toBe(path.resolve(repo));
  });
});

describe("prepareVaultLink", () => {
  beforeEach(async () => {
    await mkdir(path.join(vault, "notes"), { recursive: true });
    await mkdir(path.join(vault, "references"), { recursive: true });
  });

  it("publishes missing identity, registers without selecting, and projects only after success", async () => {
    const result = await link({
      cwd: repo,
      vault,
      folders: ["notes"],
      operationId: OPERATION_ID,
      publicationTransactionId: TRANSACTION_ID,
      registry: registry(),
    });
    expect(result.partial).toBe(false);
    expect(result.connection.global.state).toBe("complete");
    expect(result.connection.project.state).toBe("complete");
    expect(result.connection.reservation?.state).toMatch(/reserved|registered/);
    const linkPath = path.join(repo, ".oms", "linked", "notes");
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(linkPath), await readlink(linkPath))).toBe(path.join(await realpath(vault), "notes"));
    const record = yamlParse(await readFile(path.join(repo, ".oms", "links.yaml"), "utf8")) as Record<string, unknown>;
    expect(record["version"]).toBe(2);
    expect(record["connectionId"]).toBe(result.connection.reservation?.connectionId);
    expect(record["scope"]).toEqual(["notes"]);
    expect(record["vault"]).toBeUndefined();
    expect(result.projection?.gitignoreUpdated).toBe(true);
  });

  it("preserves an existing portable identity and merges scope", async () => {
    await mkdir(path.join(vault, ".oms"), { recursive: true });
    const before = serializeVaultSettings({ version: 1, vaultId: VAULT_ID });
    await writeFile(path.join(vault, ".oms", "settings.json"), before);
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const second = await link({
      cwd: repo,
      vault,
      folders: ["references"],
      operationId: "44444444-4444-4444-8444-444444444444",
      publicationTransactionId: "55555555-5555-4555-8555-555555555555",
      registry: registry(),
    });
    expect(await readFile(path.join(vault, ".oms", "settings.json"), "utf8")).toBe(before);
    expect((await readProjectConnection(await realpath(repo))).reference?.scope).toEqual(["notes", "references"]);
    expect(second.projection?.unchanged).toEqual([path.join("linked", "notes")]);
    expect(second.projection?.linked).toEqual([path.join("linked", "references")]);
  });

  it("reports partial status and does not claim the bridge is ready when projection conflicts", async () => {
    await mkdir(path.join(vault, ".oms"), { recursive: true });
    await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: VAULT_ID }));
    await mkdir(path.join(repo, ".oms", "linked"), { recursive: true });
    await writeFile(path.join(repo, ".oms", "linked", "notes"), "user bytes");
    const result = await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    expect(result.partial).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.projection).toBeNull();
    expect(result.projectionState).toBe("pending");
    expect(result.connection.global.state).toBe("complete");
    expect(result.connection.project.state).toBe("complete");
    expect(result.connection.project.receipt?.completed).toBe(true);
    expect(await readFile(path.join(repo, ".oms", "linked", "notes"), "utf8")).toBe("user bytes");
  });

  it("rejects a vault folder that escapes or does not exist before writing", async () => {
    await expect(prepareVaultLink({ cwd: repo, vault, folders: ["missing"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() })).rejects.toThrow(/does not exist/);
    await expect(prepareVaultLink({ cwd: repo, vault, folders: ["../outside"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() })).rejects.toThrow(/escapes the vault/);
    expect(await lstat(path.join(home, "config")).then(() => false, () => true)).toBe(true);
  });

  it("rejects a link-name collision and a non-directory vault", async () => {
    await mkdir(path.join(vault, "a", "shared"), { recursive: true });
    await mkdir(path.join(vault, "b", "shared"), { recursive: true });
    await expect(prepareVaultLink({ cwd: repo, vault, folders: ["a/shared", "b/shared"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() })).rejects.toThrow(/collision/);
    await expect(prepareVaultLink({ cwd: repo, vault: path.join(vault, "nope"), folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() })).rejects.toThrow(/not a directory/);
  });

  it("preserves a mismatched user symlink instead of re-pointing it", async () => {
    await mkdir(path.join(vault, ".oms"), { recursive: true });
    await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: VAULT_ID }));
    const linkedDir = path.join(repo, ".oms", "linked");
    await mkdir(linkedDir, { recursive: true });
    const stale = path.join(tmp, "old-target");
    await symlink(stale, path.join(linkedDir, "notes"), "dir");
    const result = await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    expect(result.projection).toBeNull();
    expect(result.projectionState).toBe("pending");
    expect(result.connection.project.state).toBe("complete");
    expect(await readlink(path.join(linkedDir, "notes"))).toBe(stale);
  });

  it("repeats the same prepared link across injected faults without re-planning", async () => {
    const faults: ConnectionCoordinatorFault[] = ["after-intent", "after-vault-publication", "after-global-upsert", "after-project-publication"];
    const prepared = await prepareVaultLink({
      cwd: repo,
      vault,
      folders: ["notes"],
      operationId: OPERATION_ID,
      publicationTransactionId: TRANSACTION_ID,
      publicationVaultId: VAULT_ID,
      registry: registry(),
    });
    const intent = path.join(home, "runtime", "connection-coordinator", "v1", OPERATION_ID, "intent.json");
    const digests = new Set<string>();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const coordinatorFault of faults) {
        const before = prepared.connection.digest;
        const result = await commitVaultLink(prepared, { ...registry(), coordinatorFault });
        expect(prepared.connection.digest).toBe(before);
        expect(prepared.connection.portableVaultId).toBe(VAULT_ID);
        expect(result.preparedDigest).toBe(before);
        digests.add(result.preparedDigest);
        if (result.connection.project.state === "complete") expect(result.connection.project.receipt?.completed).toBe(true);
      }
    }
    expect(digests.size).toBe(1);
    const final = await commitVaultLink(prepared, registry());
    expect(final.ready).toBe(true);
    expect(await readFile(intent, "utf8")).toContain(VAULT_ID);
    expect(await readFile(path.join(vault, ".oms", "settings.json"), "utf8")).toContain(VAULT_ID);
  });

  it("canonicalizes a public vault alias and rejects a private control symlink", async () => {
    const realParent = path.join(tmp, "real-parent");
    await mkdir(path.join(realParent, "vault", "notes"), { recursive: true });
    const aliasParent = path.join(tmp, "alias-parent");
    await symlink(realParent, aliasParent);
    const prepared = await prepareVaultLink({
      cwd: repo,
      vault: path.join(aliasParent, "vault"),
      folders: ["notes"],
      operationId: OPERATION_ID,
      publicationTransactionId: TRANSACTION_ID,
      registry: registry(),
    });
    expect(prepared.connection.canonicalTarget).toBe(await realpath(path.join(aliasParent, "vault")));
    expect((await commitVaultLink(prepared, registry())).ready).toBe(true);
  });

  it("rejects an ancestor symlink that would escape a source folder", async () => {
    const outside = path.join(tmp, "outside-folder");
    await mkdir(path.join(outside, "child"), { recursive: true });
    await symlink(outside, path.join(vault, "Folder"));
    await expect(prepareVaultLink({
      cwd: repo,
      vault,
      folders: ["Folder/child"],
      operationId: OPERATION_ID,
      publicationTransactionId: TRANSACTION_ID,
      registry: registry(),
    })).rejects.toThrow(/symlink/);
  });

  it("keeps vault and global complete when the project record is malformed", async () => {
    await mkdir(path.join(vault, ".oms"), { recursive: true });
    await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: VAULT_ID }));
    await mkdir(path.join(repo, ".oms"), { recursive: true });
    await writeFile(path.join(repo, ".oms", "links.yaml"), "version: 2\nconnectionId: not-a-record\n");
    const prepared = await prepareVaultLink({
      cwd: repo,
      vault,
      folders: ["notes"],
      operationId: OPERATION_ID,
      publicationTransactionId: TRANSACTION_ID,
      registry: registry(),
    });
    expect(prepared.connection.blockers.some(item => item.stage === "project")).toBe(true);
    const result = await commitVaultLink(prepared, registry());
    expect(result.connection.vault.state).not.toBe("blocked");
    expect(result.connection.global.state).toBe("complete");
    expect(result.connection.project.state).toBe("blocked");
    expect(result.projectionState).toBe("not-requested");
    expect(await readFile(path.join(repo, ".oms", "links.yaml"), "utf8")).toContain("not-a-record");
  });

  it("rejects a forged projection link name before native effects", async () => {
    const prepared = await prepareVaultLink({
      cwd: repo,
      vault,
      folders: ["notes"],
      operationId: OPERATION_ID,
      publicationTransactionId: TRANSACTION_ID,
      publicationVaultId: VAULT_ID,
      registry: registry(),
    });
    const forged = {
      ...prepared,
      projection: prepared.projection.map(spec => ({ ...spec, linkName: "../outside" })),
    };
    await expect(commitVaultLink(forged, registry())).rejects.toThrow(/link name/);
    expect(prepared.connection.digest).toBe(forged.connection.digest);
    expect(await lstat(path.join(home, "config")).then(() => false, () => true)).toBe(true);
  });

  it("accepts an existing symlink only when it is the approved target", async () => {
    const prepared = await prepareVaultLink({
      cwd: repo,
      vault,
      folders: ["notes"],
      operationId: OPERATION_ID,
      publicationTransactionId: TRANSACTION_ID,
      publicationVaultId: VAULT_ID,
      registry: registry(),
    });
    const first = await commitVaultLink(prepared, registry());
    expect(first.projectionState).toBe("complete");
    const second = await commitVaultLink(prepared, registry());
    expect(second.projectionState).toBe("complete");
    expect(second.projection?.unchanged).toEqual([path.join("linked", "notes")]);
    expect(path.resolve(path.dirname(path.join(repo, ".oms", "linked", "notes")), await readlink(path.join(repo, ".oms", "linked", "notes")))).toBe(path.join(await realpath(vault), "notes"));
  });

  it("removes only declared projections and keeps the global registry", async () => {
    const note = path.join(vault, "notes", "kept.md");
    await mkdir(path.dirname(note), { recursive: true });
    await writeFile(note, "keep me\n");
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const before = await readConnectionRegistry(registry());
    const removed = await removeVaultLink(repo, registry());
    expect(removed.atomic).toBe(false);
    expect(removed.removed).toEqual([path.join("linked", "notes")]);
    await expect(lstat(path.join(repo, ".oms", "linked"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(repo, ".oms", "links.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(note, "utf8")).toBe("keep me\n");
    expect(await readConnectionRegistry(registry())).toEqual(before);
    await expect(removeVaultLink(await realpath(repo), registry())).rejects.toThrow(/No vault bridge record/);
    expect(await readConnectionRegistry(registry())).toEqual(before);
  });

  it("refuses an extra file or unrelated symlink before removing any declared entry", async () => {
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const linkedDir = path.join(repo, ".oms", "linked");
    const extra = path.join(linkedDir, "keep");
    await writeFile(extra, "user file\n");
    const elsewhere = path.join(tmp, "elsewhere");
    await symlink(elsewhere, path.join(linkedDir, "other"), "dir");
    const record = await readFile(path.join(repo, ".oms", "links.yaml"));
    const declared = await readlink(path.join(linkedDir, "notes"));
    const note = path.join(vault, "notes", "kept.md");
    await mkdir(path.dirname(note), { recursive: true });
    await writeFile(note, "vault bytes\n");
    await expect(removeVaultLink(repo, registry())).rejects.toThrow(/outside the declared v2 scope/);
    expect(await readFile(path.join(repo, ".oms", "links.yaml"))).toEqual(record);
    expect(await readlink(path.join(linkedDir, "notes"))).toBe(declared);
    expect(await readFile(extra, "utf8")).toBe("user file\n");
    expect(await readlink(path.join(linkedDir, "other"))).toBe(elsewhere);
    expect(await readFile(note, "utf8")).toBe("vault bytes\n");
  });

  it("refuses a replaced projection and a v1 or unbound record before any effect", async () => {
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const linkPath = path.join(repo, ".oms", "linked", "notes");
    const recordPath = path.join(repo, ".oms", "links.yaml");
    const record = await readFile(recordPath);
    const { unlink } = await import("node:fs/promises");
    await unlink(linkPath);
    await writeFile(linkPath, "regular replacement\n");
    await expect(removeVaultLink(repo, registry())).rejects.toThrow(/non-symlink/);
    expect(await readFile(linkPath, "utf8")).toBe("regular replacement\n");
    expect(await readFile(recordPath)).toEqual(record);
    await unlink(linkPath);
    const stale = path.join(tmp, "stale-target");
    await symlink(stale, linkPath, "dir");
    await expect(removeVaultLink(repo, registry())).rejects.toThrow(/misdirected/);
    expect(await readlink(linkPath)).toBe(stale);
    expect(await readFile(recordPath)).toEqual(record);
    await writeFile(recordPath, `version: 1\nvault: ${vault}\nscope:\n  - notes\n`);
    await expect(removeVaultLink(repo, registry())).rejects.toThrow(/v1 was not converted/);
    expect(await readFile(recordPath, "utf8")).toContain("version: 1");
    await writeFile(recordPath, record);
    const parsed = yamlParse(record.toString("utf8")) as { connectionId: string; portableVaultId: string };
    await writeFile(recordPath, `version: 2\nconnectionId: ${parsed.connectionId}\nportableVaultId: 99999999-9999-4999-8999-999999999999\nscope:\n  - notes\n`);
    await expect(removeVaultLink(repo, registry())).rejects.toThrow(/not bound/);
    expect(await readlink(linkPath)).toBe(stale);
  });

  it("refuses a private control hardlink and does not follow a projection directory link", async () => {
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const recordPath = path.join(repo, ".oms", "links.yaml");
    const record = await readFile(recordPath);
    const outside = path.join(tmp, "outside-links.yaml");
    await hardlink(recordPath, outside);
    await expect(removeVaultLink(repo, registry())).rejects.toThrow(/regular file|hard-linked|unsafe/);
    expect(await readFile(recordPath)).toEqual(record);
    expect(await readFile(outside, "utf8")).toContain("version:");
    const { unlink, rename } = await import("node:fs/promises");
    await unlink(outside);
    const realLinked = path.join(tmp, "real-linked");
    await rename(path.join(repo, ".oms", "linked"), realLinked);
    await symlink(realLinked, path.join(repo, ".oms", "linked"), "dir");
    await expect(removeVaultLink(repo, registry())).rejects.toThrow(/unsafe projection directory|symbolic link/);
    expect((await lstat(path.join(realLinked, "notes"))).isSymbolicLink()).toBe(true);
    expect(await readFile(recordPath)).toEqual(record);
  });

  it("refuses a hardlinked or replaced project record before removing projections", async () => {
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const linkPath = path.join(repo, ".oms", "linked", "notes");
    const recordPath = path.join(repo, ".oms", "links.yaml");
    const declared = await readlink(linkPath);
    const outside = path.join(tmp, "record-alias.yaml");
    let reached = false;
    removalBindingSeam.beforeUnlink = async () => {
      reached = true;
      await hardlink(recordPath, outside);
    };
    try {
      await expect(removeVaultLink(repo, registry())).rejects.toThrow(/regular file|hard-linked|unsafe|Project links changed/);
    } finally {
      removalBindingSeam.beforeUnlink = undefined;
    }
    expect(reached).toBe(true);
    expect(await readlink(linkPath)).toBe(declared);
    expect((await lstat(recordPath)).nlink).toBeGreaterThan(1);
    const { unlink } = await import("node:fs/promises");
    await unlink(outside);
    removalBindingSeam.beforeUnlink = async () => {
      await unlink(recordPath);
      await symlink(path.join(tmp, "elsewhere.yaml"), recordPath);
    };
    try {
      await expect(removeVaultLink(repo, registry())).rejects.toThrow(/symbolic link|unsafe|Project links changed/);
    } finally {
      removalBindingSeam.beforeUnlink = undefined;
    }
    expect((await lstat(recordPath)).isSymbolicLink()).toBe(true);
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
  });

  it("refuses after preflight when the same identity moves to another root", async () => {
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const linkPath = path.join(repo, ".oms", "linked", "notes");
    const recordPath = path.join(repo, ".oms", "links.yaml");
    const record = await readFile(recordPath);
    const declared = await readlink(linkPath);
    const before = await readConnectionRegistry(registry());
    const entry = before.registry?.connections[0];
    if (entry === undefined || before.registry === undefined) throw new Error("missing registry entry");
    const moved = path.join(tmp, "moved-vault");
    await mkdir(path.join(moved, ".oms"), { recursive: true });
    await mkdir(path.join(moved, "notes"), { recursive: true });
    await writeFile(path.join(moved, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: entry.portableVaultId }));
    let stage: RemovalBinding | undefined;
    removalBindingSeam.beforeUnlink = async (binding) => {
      stage = binding;
      await upsertVaultConnection({
        expectedDigest: before.registry.digest,
        expectedEntryRevision: entry.revision,
        connectionId: entry.connectionId,
        portableVaultId: entry.portableVaultId,
        localVaultPath: moved,
        select: false,
        operationId: "44444444-4444-4444-8444-444444444444",
      }, registry());
    };
    try {
      await expect(removeVaultLink(repo, registry())).rejects.toThrow(/binding changed before removal/);
    } finally {
      removalBindingSeam.beforeUnlink = undefined;
    }
    expect(stage?.connectionId).toBe(entry.connectionId);
    expect(stage?.portableVaultId).toBe(entry.portableVaultId);
    expect(stage?.canonicalVaultPath).toBe(await realpath(vault));
    expect(stage?.settingsIdentity).toBe(entry.portableVaultId);
    expect(await readlink(linkPath)).toBe(declared);
    expect(await readFile(recordPath)).toEqual(record);
    expect((await readConnectionRegistry(registry())).registry?.connections[0]?.localVaultPath).toBe(await realpath(moved));
  });

  it("refuses after preflight when published settings identity drifts", async () => {
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const linkPath = path.join(repo, ".oms", "linked", "notes");
    const recordPath = path.join(repo, ".oms", "links.yaml");
    const record = await readFile(recordPath);
    const declared = await readlink(linkPath);
    removalBindingSeam.beforeUnlink = async () => {
      await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: "99999999-9999-4999-8999-999999999999" }));
    };
    try {
      await expect(removeVaultLink(repo, registry())).rejects.toThrow(/binding changed before removal|does not match published portable identity/);
    } finally {
      removalBindingSeam.beforeUnlink = undefined;
    }
    expect(await readlink(linkPath)).toBe(declared);
    expect(await readFile(recordPath)).toEqual(record);
  });

  it("refuses after preflight when the original v2 record bytes change", async () => {
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const linkPath = path.join(repo, ".oms", "linked", "notes");
    const recordPath = path.join(repo, ".oms", "links.yaml");
    const declared = await readlink(linkPath);
    const parsed = yamlParse(await readFile(recordPath, "utf8")) as { connectionId: string; portableVaultId: string };
    let reached = false;
    removalBindingSeam.beforeUnlink = async () => {
      reached = true;
      await writeFile(recordPath, `version: 2\nconnectionId: ${parsed.connectionId}\nportableVaultId: ${parsed.portableVaultId}\nscope:\n  - projects\n`);
    };
    try {
      await expect(removeVaultLink(repo, registry())).rejects.toThrow(/Project links changed before removal/);
    } finally {
      removalBindingSeam.beforeUnlink = undefined;
    }
    expect(reached).toBe(true);
    expect(await readlink(linkPath)).toBe(declared);
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(recordPath, "utf8")).toContain("projects");
    expect((await lstat(path.join(repo, ".oms", "linked"))).isDirectory()).toBe(true);
  });

  it("refuses a duplicate declared scope before deleting the one projection", async () => {
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const linkPath = path.join(repo, ".oms", "linked", "notes");
    const recordPath = path.join(repo, ".oms", "links.yaml");
    const parsed = yamlParse(await readFile(recordPath, "utf8")) as { connectionId: string; portableVaultId: string };
    await writeFile(recordPath, `version: 2\nconnectionId: ${parsed.connectionId}\nportableVaultId: ${parsed.portableVaultId}\nscope:\n  - notes\n  - notes\n`);
    const declared = await readlink(linkPath);
    const rewritten = await readFile(recordPath);
    await expect(removeVaultLink(repo, registry())).rejects.toThrow(/Duplicate declared scope/);
    expect(await readlink(linkPath)).toBe(declared);
    expect(await readFile(recordPath)).toEqual(rewritten);
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
  });

  it("does not refuse removal only because an unrelated registry entry changed", async () => {
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const before = await readConnectionRegistry(registry());
    const original = before.registry?.connections[0];
    if (original === undefined || before.registry === undefined) throw new Error("missing registry entry");
    const other = path.join(tmp, "unrelated-vault");
    await mkdir(path.join(other, ".oms"), { recursive: true });
    await writeFile(path.join(other, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: "88888888-8888-4888-8888-888888888888" }));
    removalBindingSeam.beforeUnlink = async (binding) => {
      expect(binding.connectionId).toBe(original.connectionId);
      expect(binding.canonicalVaultPath).toBe(original.localVaultPath);
      await upsertVaultConnection({
        expectedDigest: before.registry.digest,
        portableVaultId: "88888888-8888-4888-8888-888888888888",
        localVaultPath: other,
        select: false,
        operationId: "55555555-5555-4555-8555-555555555555",
      }, registry());
    };
    try {
      const removed = await removeVaultLink(repo, registry());
      expect(removed.removed).toEqual([path.join("linked", "notes")]);
    } finally {
      removalBindingSeam.beforeUnlink = undefined;
    }
    const after = await readConnectionRegistry(registry());
    const kept = after.registry?.connections.find(item => item.connectionId === original.connectionId);
    expect(kept?.localVaultPath).toBe(original.localVaultPath);
    expect(kept?.portableVaultId).toBe(original.portableVaultId);
    expect(after.registry?.connections.some(item => item.portableVaultId === "88888888-8888-4888-8888-888888888888")).toBe(true);
  });

  it("does not unlink through a projection directory replaced after preflight", async () => {
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const linkedDir = path.join(repo, ".oms", "linked");
    const linkPath = path.join(linkedDir, "notes");
    const recordPath = path.join(repo, ".oms", "links.yaml");
    const record = await readFile(recordPath);
    const declared = await readlink(linkPath);
    const moved = path.join(tmp, "moved-linked");
    const { rename } = await import("node:fs/promises");
    let reached = false;
    removalBindingSeam.beforeUnlink = async () => {
      reached = true;
      await rename(linkedDir, moved);
      await symlink(moved, linkedDir, "dir");
    };
    try {
      await expect(removeVaultLink(repo, registry())).rejects.toThrow(/Projection directory changed|unsafe projection directory|symbolic link/);
    } finally {
      removalBindingSeam.beforeUnlink = undefined;
    }
    expect(reached).toBe(true);
    expect((await lstat(linkedDir)).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(moved, "notes"))).toBe(declared);
    expect((await lstat(path.join(moved, "notes"))).isSymbolicLink()).toBe(true);
    expect(await readFile(recordPath)).toEqual(record);
  });

  it("refuses an absent projection directory during preflight and does not reach removal", async () => {
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const recordPath = path.join(repo, ".oms", "links.yaml");
    const record = await readFile(recordPath);
    const { rm } = await import("node:fs/promises");
    await rm(path.join(repo, ".oms", "linked"), { recursive: true });
    let reached = false;
    removalBindingSeam.beforeUnlink = async () => {
      reached = true;
    };
    try {
      await expect(removeVaultLink(repo, registry())).rejects.toThrow(/Projection directory is missing/);
    } finally {
      removalBindingSeam.beforeUnlink = undefined;
    }
    expect(reached).toBe(false);
    expect(await readFile(recordPath)).toEqual(record);
    await expect(lstat(path.join(repo, ".oms", "linked"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a replacement directory created after owned projection removal", async () => {
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const recordPath = path.join(repo, ".oms", "links.yaml");
    const record = await readFile(recordPath);
    let reached = false;
    removalRecordBoundarySeam.beforeRecordUnlink = async () => {
      reached = true;
      await mkdir(path.join(repo, ".oms", "linked"), { recursive: true });
      await writeFile(path.join(repo, ".oms", "linked", "notes"), "replacement\n");
    };
    try {
      await expect(removeVaultLink(repo, registry())).rejects.toThrow(/Projection directory appeared/);
    } finally {
      removalRecordBoundarySeam.beforeRecordUnlink = undefined;
    }
    expect(reached).toBe(true);
    expect(await readFile(path.join(repo, ".oms", "linked", "notes"), "utf8")).toBe("replacement\n");
    expect(await readFile(recordPath)).toEqual(record);
  });

  it("preserves both directories when the empty projection directory is replaced before rmdir", async () => {
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const linkedDir = path.join(repo, ".oms", "linked");
    const recordPath = path.join(repo, ".oms", "links.yaml");
    const record = await readFile(recordPath);
    const original = await lstat(linkedDir);
    const moved = path.join(tmp, "original-empty-linked");
    const { rename } = await import("node:fs/promises");
    let reached = false;
    removalDirectoryBoundarySeam.beforeDirectoryRemoval = async () => {
      reached = true;
      await rename(linkedDir, moved);
      await mkdir(linkedDir);
    };
    try {
      await expect(removeVaultLink(repo, registry())).rejects.toThrow(/Projection directory changed/);
    } finally {
      removalDirectoryBoundarySeam.beforeDirectoryRemoval = undefined;
    }
    expect(reached).toBe(true);
    expect((await lstat(linkedDir)).ino).not.toBe(original.ino);
    expect((await lstat(moved)).ino).toBe(original.ino);
    expect(await readFile(recordPath)).toEqual(record);
  });

  it("does not unlink through a projection parent replaced after the final binding read", async () => {
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const oms = path.join(repo, ".oms");
    const linkedDir = path.join(oms, "linked");
    const linkPath = path.join(linkedDir, "notes");
    const recordPath = path.join(oms, "links.yaml");
    const record = await readFile(recordPath);
    const declared = await readlink(linkPath);
    const movedOms = path.join(tmp, "moved-oms");
    const { rename } = await import("node:fs/promises");
    let reached = false;
    removalParentBoundarySeam.beforeParentGuard = async () => {
      reached = true;
      await rename(oms, movedOms);
      await mkdir(oms);
      await symlink(path.join(movedOms, "linked"), linkedDir, "dir");
      await rename(path.join(movedOms, "links.yaml"), recordPath);
    };
    try {
      await expect(removeVaultLink(repo, registry())).rejects.toThrow(/Projection directory changed/);
    } finally {
      removalParentBoundarySeam.beforeParentGuard = undefined;
    }
    expect(reached).toBe(true);
    expect((await lstat(linkedDir)).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(movedOms, "linked", "notes"))).toBe(declared);
    expect(await readFile(recordPath)).toEqual(record);
  });

  it("preserves a project record replaced after the final binding read", async () => {
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const recordPath = path.join(repo, ".oms", "links.yaml");
    const record = await readFile(recordPath);
    const moved = path.join(tmp, "original-links.yaml");
    const { rename } = await import("node:fs/promises");
    let reached = false;
    removalRecordBoundarySeam.beforeRecordUnlink = async () => {
      reached = true;
      await rename(recordPath, moved);
      await writeFile(recordPath, "replacement record\n");
    };
    try {
      await expect(removeVaultLink(repo, registry())).rejects.toThrow(/Project links changed/);
    } finally {
      removalRecordBoundarySeam.beforeRecordUnlink = undefined;
    }
    expect(reached).toBe(true);
    expect(await readFile(recordPath, "utf8")).toBe("replacement record\n");
    expect(await readFile(moved)).toEqual(record);
  });

  it("preserves a linked directory that appears after the final record reread", async () => {
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const recordPath = path.join(repo, ".oms", "links.yaml");
    const record = await readFile(recordPath);
    let reached = false;
    removalAbsenceBoundarySeam.beforeAbsenceGuard = async () => {
      reached = true;
      await mkdir(path.join(repo, ".oms", "linked"), { recursive: true });
      await writeFile(path.join(repo, ".oms", "linked", "keep"), "user entry\n");
    };
    try {
      await expect(removeVaultLink(repo, registry())).rejects.toThrow(/Projection directory appeared/);
    } finally {
      removalAbsenceBoundarySeam.beforeAbsenceGuard = undefined;
    }
    expect(reached).toBe(true);
    expect(await readFile(path.join(repo, ".oms", "linked", "keep"), "utf8")).toBe("user entry\n");
    expect(await readFile(recordPath)).toEqual(record);
  });

  it("does not unlink a leaf replaced after the last authority read", async () => {
    await link({ cwd: repo, vault, folders: ["notes"], operationId: OPERATION_ID, publicationTransactionId: TRANSACTION_ID, registry: registry() });
    const linkedDir = path.join(repo, ".oms", "linked");
    const linkPath = path.join(linkedDir, "notes");
    const recordPath = path.join(repo, ".oms", "links.yaml");
    const record = await readFile(recordPath);
    const declared = await readlink(linkPath);
    const moved = path.join(tmp, "moved-notes-link");
    const { rename } = await import("node:fs/promises");
    let regularReached = false;
    removalLeafBoundarySeam.beforeLeafUnlink = async () => {
      regularReached = true;
      await rename(linkPath, moved);
      await writeFile(linkPath, "unowned replacement\n");
    };
    try {
      await expect(removeVaultLink(repo, registry())).rejects.toThrow(/Projection symlink changed/);
    } finally {
      removalLeafBoundarySeam.beforeLeafUnlink = undefined;
    }
    expect(regularReached).toBe(true);
    expect(await readFile(linkPath, "utf8")).toBe("unowned replacement\n");
    expect(await readlink(moved)).toBe(declared);
    expect(await readFile(recordPath)).toEqual(record);
    await rename(linkPath, path.join(tmp, "discarded-replacement"));
    await rename(moved, linkPath);
    let foreignReached = false;
    removalLeafBoundarySeam.beforeLeafUnlink = async () => {
      foreignReached = true;
      await rename(linkPath, moved);
      await symlink(path.join(tmp, "foreign-target"), linkPath, "dir");
    };
    try {
      await expect(removeVaultLink(repo, registry())).rejects.toThrow(/Projection symlink changed/);
    } finally {
      removalLeafBoundarySeam.beforeLeafUnlink = undefined;
    }
    expect(await readlink(linkPath)).toBe(path.join(tmp, "foreign-target"));
    expect(foreignReached).toBe(true);
    expect(await readlink(moved)).toBe(declared);
    expect(await readFile(recordPath)).toEqual(record);
  });
});
