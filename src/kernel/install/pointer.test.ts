import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HostVaultPointerError,
  deleteHostVaultPointer,
  hostVaultPointerPath,
  readHostVaultPointer,
  writeHostVaultPointer,
} from "./pointer.js";

async function fixture(): Promise<{ readonly root: string; readonly vaultA: string; readonly vaultB: string; readonly pointer: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "oms-pointer-"));
  const vaultA = path.join(root, "vault-a");
  const vaultB = path.join(root, "vault-b");
  await Promise.all([mkdir(vaultA), mkdir(vaultB)]);
  return { root, vaultA, vaultB, pointer: hostVaultPointerPath({ XDG_CONFIG_HOME: path.join(root, "xdg") }, root) };
}

describe("host vault pointer", () => {
  it("uses XDG_CONFIG_HOME and writes a canonical, private pointer", async () => {
    const { root, vaultA, pointer } = await fixture();
    const receipt = await writeHostVaultPointer(vaultA, undefined, { pointerPath: pointer });
    expect(receipt.pointer?.vault).toBe(await realpath(vaultA));
    expect(await readFile(pointer, "utf-8")).toBe(`${JSON.stringify(receipt.pointer)}\n`);
    expect((await stat(path.dirname(pointer))).mode & 0o777).toBe(0o700);
    expect((await stat(pointer)).mode & 0o777).toBe(0o600);
    expect(pointer).toBe(path.join(root, "xdg", "oms", "vault.json"));
    expect(hostVaultPointerPath({}, root)).toBe(path.join(root, ".config", "oms", "vault.json"));
  });

  it("rejects malformed records, unknown fields, invalid signatures, and noncanonical vaults", async () => {
    const { vaultA, pointer } = await fixture();
    await mkdir(path.dirname(pointer), { recursive: true });
    await writeFile(pointer, "{}\n", "utf-8");
    await expect(readHostVaultPointer({ pointerPath: pointer })).rejects.toThrow(HostVaultPointerError);
    await writeFile(pointer, JSON.stringify({ version: 1, vault: vaultA, signature: "bad", extra: true }), "utf-8");
    await expect(readHostVaultPointer({ pointerPath: pointer })).rejects.toThrow(HostVaultPointerError);
    const alias = path.join(path.dirname(vaultA), "vault-alias");
    await symlink(vaultA, alias);
    await writeFile(pointer, JSON.stringify({ version: 1, vault: alias, signature: "bad" }), "utf-8");
    await expect(readHostVaultPointer({ pointerPath: pointer })).rejects.toThrow(HostVaultPointerError);
  });

  it("rejects stale CAS writes and replaces A with B", async () => {
    const { vaultA, vaultB, pointer } = await fixture();
    const first = await writeHostVaultPointer(vaultA, undefined, { pointerPath: pointer });
    const second = await writeHostVaultPointer(vaultB, first.pointer?.signature, { pointerPath: pointer });
    await expect(writeHostVaultPointer(vaultA, first.pointer?.signature, { pointerPath: pointer })).rejects.toThrow(HostVaultPointerError);
    expect((await readHostVaultPointer({ pointerPath: pointer })).pointer?.vault).toBe(await realpath(vaultB));
    expect(second.pointer?.vault).toBe(await realpath(vaultB));
  });

  it("serializes concurrent writers so one expected signature cannot commit twice", async () => {
    const { root, vaultA, vaultB, pointer } = await fixture();
    const vaultC = path.join(root, "vault-c");
    await mkdir(vaultC);
    const first = await writeHostVaultPointer(vaultA, undefined, { pointerPath: pointer });
    const results = await Promise.allSettled([
      writeHostVaultPointer(vaultB, first.pointer?.signature, { pointerPath: pointer }),
      writeHostVaultPointer(vaultC, first.pointer?.signature, { pointerPath: pointer }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });

  it("allows only one contender to take over the same stale lock instance", async () => {
    const { root, vaultA, vaultB, pointer } = await fixture();
    const vaultC = path.join(root, "vault-c");
    await mkdir(vaultC);
    const first = await writeHostVaultPointer(vaultA, undefined, { pointerPath: pointer });
    const lock = `${pointer}.lock`;
    await mkdir(lock);
    await writeFile(path.join(lock, "owner.json"), `${JSON.stringify({ pid: 99999999, token: "dead" })}\n`);
    const results = await Promise.allSettled([
      writeHostVaultPointer(vaultB, first.pointer?.signature, { pointerPath: pointer }),
      writeHostVaultPointer(vaultC, first.pointer?.signature, { pointerPath: pointer }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });

  it("returns dry-run receipts without changing bytes", async () => {
    const { vaultA, vaultB, pointer } = await fixture();
    const first = await writeHostVaultPointer(vaultA, undefined, { pointerPath: pointer });
    const before = await readFile(pointer, "utf-8");
    const receipt = await writeHostVaultPointer(vaultB, first.pointer?.signature, { pointerPath: pointer, dryRun: true });
    expect(receipt).toMatchObject({ operation: "write", dryRun: true, changed: true });
    expect(await readFile(pointer, "utf-8")).toBe(before);
  });

  it("repairs a valid signed pointer after the old vault moved", async () => {
    const { vaultA, vaultB, pointer } = await fixture();
    const first = await writeHostVaultPointer(vaultA, undefined, { pointerPath: pointer });
    await rm(vaultA, { recursive: true });
    await expect(readHostVaultPointer({ pointerPath: pointer })).rejects.toThrow("does not exist");
    const repaired = await writeHostVaultPointer(vaultB, first.pointer?.signature, { pointerPath: pointer });
    expect(repaired.pointer?.vault).toBe(await realpath(vaultB));
  });

  it("removes only with the current signature and reports dry-run removal", async () => {
    const { vaultA, pointer } = await fixture();
    const first = await writeHostVaultPointer(vaultA, undefined, { pointerPath: pointer });
    const dryRun = await deleteHostVaultPointer(first.pointer?.signature, { pointerPath: pointer, dryRun: true });
    expect(dryRun).toMatchObject({ operation: "remove", changed: true, dryRun: true });
    expect(existsSync(pointer)).toBe(true);
    await deleteHostVaultPointer(first.pointer?.signature, { pointerPath: pointer });
    expect(existsSync(pointer)).toBe(false);
  });
});
