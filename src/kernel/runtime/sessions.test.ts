import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { chmod, link, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOmsSelectionSession, OmsSessionError, readOmsSelectionSession, SELECTION_SESSION_CAP, SELECTION_SESSION_TTL_MS, validateOmsSelectionSessionInput, type OmsSelectionSession, type OmsSessionStoreOptions } from "./sessions.js";
import type { ContractSelectionBinding } from "../templates/source-registry.js";
import type { Digest } from "../templates/types.js";

const roots: string[] = [];
const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Digest;
const SOURCE = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Digest;
const CONNECTION = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";

function temporary(name: string): string {
  const created = mkdtempSync(path.join(tmpdir(), `${name}-`));
  const root = realpathSync(created);
  roots.push(root);
  return root;
}

function selection(overrides: Partial<ContractSelectionBinding> = {}): ContractSelectionBinding {
  return {
    version: 1,
    templateId: "literature",
    policyRevision: 3,
    contractDigest: DIGEST,
    sourceDigest: SOURCE,
    sourceIdentity: "literature-source",
    sourcePath: "Templates/literature.md",
    headingBindings: { topic: "Budget" },
    ...overrides,
  };
}

async function fixture(): Promise<{ readonly root: string; readonly vault: string; readonly sessionsRoot: string; readonly options: OmsSessionStoreOptions }> {
  const root = temporary("oms-selection-session");
  const vault = path.join(root, "vault");
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(vault);
  await writeFile(path.join(vault, "owned.md"), "vault-owned\n");
  await mkdir(path.join(vault, ".oms"));
  await writeFile(path.join(vault, ".oms", "template-policy.json"), "{\"version\":5}\n");
  return { root, vault, sessionsRoot, options: { vaultPath: vault, sessionsRoot, connectionId: CONNECTION, vaultId: VAULT_ID } };
}

async function snapshot(directory: string): Promise<string> {
  const files = await readdir(directory, { recursive: true, withFileTypes: true });
  const entries = await Promise.all(files.filter(entry => entry.isFile()).map(async entry => {
    const relative = path.join(entry.parentPath, entry.name);
    return `${path.relative(directory, relative)}\0${await readFile(relative, "utf8")}`;
  }));
  return entries.sort().join("\n");
}
function recordFile(options: OmsSessionStoreOptions, sessionId: string): string {
  return path.join(options.sessionsRoot, CONNECTION, `${sessionId}.json`);
}

function expectSessionError(error: unknown, code: OmsSessionError["code"]): void {
  expect(error).toBeInstanceOf(OmsSessionError);
  expect(error).toMatchObject({ code });
}
async function recordNames(options: OmsSessionStoreOptions): Promise<string[]> {
  return (await readdir(path.join(options.sessionsRoot, CONNECTION))).filter(name => name.endsWith(".json")).sort();
}

function installFsFailure(method: "open" | "rm", when: (args: readonly unknown[]) => boolean, code = "EIO"): { calls: number; restore: () => void } {
  const state = { calls: 0 };
  const original = fs.promises[method];
  const replacement = (async (...args: unknown[]) => {
    state.calls += 1;
    if (when(args)) {
      const error = new Error(`injected ${method} failure`) as NodeJS.ErrnoException;
      error.code = code;
      throw error;
    }
    return await (original as (...values: unknown[]) => Promise<unknown>)(...args);
  }) as typeof original;
  vi.spyOn(fs.promises, method).mockImplementation(replacement);
  syncBuiltinESMExports();
  return { get calls() { return state.calls; }, restore: () => { vi.mocked(fs.promises[method]).mockRestore(); syncBuiltinESMExports(); } };
}

function once(predicate: (args: readonly unknown[]) => boolean): (args: readonly unknown[]) => boolean {
  let fired = false;
  return args => {
    if (fired || !predicate(args)) return false;
    fired = true;
    return true;
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("minimal selection sessions", () => {
  it("round-trips only the allowlisted selection metadata", async () => {
    const { vault, options } = await fixture();
    const before = await snapshot(vault);
    const created = await createOmsSelectionSession({ notePath: "Notes/topic.md", selection: selection() }, options);
    const read = await readOmsSelectionSession(created.sessionId, options);
    expect(read).toEqual(created);
    expect(created).toEqual({
      version: 1,
      sessionId: created.sessionId,
      createdAt: created.createdAt,
      connectionId: CONNECTION,
      vaultId: VAULT_ID,
      vaultFingerprint: created.vaultFingerprint,
      notePath: "Notes/topic.md",
      selection: selection(),
    });
    expect(created.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(created.vaultFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(created)).toEqual(["version", "sessionId", "createdAt", "connectionId", "vaultId", "vaultFingerprint", "notePath", "selection"]);
    expect(created.connectionId).toBe(CONNECTION);
    expect(created.vaultId).toBe(VAULT_ID);
    expect(Object.keys(created.selection)).toEqual(["version", "templateId", "policyRevision", "contractDigest", "sourceDigest", "sourceIdentity", "sourcePath", "headingBindings"]);
    const record = JSON.parse(await readFile(recordFile(options, created.sessionId), "utf8")) as OmsSelectionSession;
    expect(record).toEqual(created);
    expect(JSON.stringify(record)).not.toContain("\"text\"");
    expect(JSON.stringify(record)).not.toContain("effectivePolicy");
    expect((await stat(recordFile(options, created.sessionId))).mode & 0o777).toBe(0o600);
    expect((await stat(options.sessionsRoot)).mode & 0o777).toBe(0o700);
    expect(await snapshot(vault)).toBe(before);
  });

  it("rejects extra fields and oversized heading payloads before publication", async () => {
    const { options } = await fixture();
    const extra = { ...selection(), source: { text: "do not store" } };
    await expect(createOmsSelectionSession({ notePath: "Notes/a.md", selection: extra as ContractSelectionBinding }, options)).rejects.toSatisfy((error: unknown) => {
      expectSessionError(error, "SESSION_INVALID");
      return true;
    });
    await expect(createOmsSelectionSession({
      notePath: "Notes/a.md",
      selection: selection({ headingBindings: { topic: "x".repeat(513) } }),
    }, options)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    await expect(readOmsSelectionSession(randomUUID(), options)).resolves.toBeNull();
    await expect(readdir(options.sessionsRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns null for a missing record without creating storage", async () => {
    const { vault, sessionsRoot, options } = await fixture();
    const before = await snapshot(vault);
    await expect(readOmsSelectionSession(randomUUID(), options)).resolves.toBeNull();
    expect(lstatSync(sessionsRoot, { throwIfNoEntry: false })).toBeUndefined();
    expect(await snapshot(vault)).toBe(before);
  });

  it("rejects the wrong vault, an unsafe id, and a note escape", async () => {
    const { root, vault, options } = await fixture();
    const created = await createOmsSelectionSession({ notePath: "Notes/a.md", selection: selection({ templateId: null, sourceDigest: null, sourceIdentity: null, sourcePath: null, headingBindings: {} }) }, options);
    const other = path.join(root, "other-vault");
    await mkdir(other);
    await expect(readOmsSelectionSession(created.sessionId, { ...options, vaultPath: other })).rejects.toMatchObject({ code: "SESSION_VAULT_MISMATCH" });
    await expect(readOmsSelectionSession("../escape", options)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    await expect(createOmsSelectionSession({ notePath: "../outside.md", selection: selection() }, options)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    await expect(createOmsSelectionSession({ notePath: "/etc/passwd.md", selection: selection() }, options)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    expect(await readOmsSelectionSession(created.sessionId, options)).toEqual(created);
    expect(await snapshot(vault)).toContain("owned.md");
  });

  it("rejects tampered digests and unknown record fields", async () => {
    const { options } = await fixture();
    const created = await createOmsSelectionSession({ notePath: "Notes/a.md", selection: selection() }, options);
    const file = recordFile(options, created.sessionId);
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    raw.reviewer = "do not persist";
    await writeFile(file, `${JSON.stringify(raw)}\n`);
    await expect(readOmsSelectionSession(created.sessionId, options)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    const rebound = structuredClone(created) as { selection: { contractDigest: string } };
    rebound.selection.contractDigest = "sha256:not-a-digest";
    await writeFile(file, `${JSON.stringify(rebound)}\n`);
    await expect(readOmsSelectionSession(created.sessionId, options)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    await writeFile(file, "{");
    await expect(readOmsSelectionSession(created.sessionId, options)).rejects.toMatchObject({ code: "SESSION_CORRUPT" });
  });

  it("rejects a sessions root inside the vault, including a symlink alias, and linked records", async () => {
    const { root, vault, options } = await fixture();
    const inside = path.join(vault, "sessions");
    await expect(createOmsSelectionSession({ notePath: "Notes/a.md", selection: selection() }, { ...options, sessionsRoot: inside })).rejects.toMatchObject({ code: "SESSION_ROOT_INSIDE_VAULT" });
    const alias = path.join(root, "vault-alias");
    await symlink(vault, alias, "dir");
    await expect(createOmsSelectionSession({ notePath: "Notes/a.md", selection: selection() }, { ...options, vaultPath: alias })).rejects.toMatchObject({ code: "SESSION_UNSAFE" });
    const linkedRoot = path.join(root, "linked-sessions");
    await symlink(vault, linkedRoot, "dir");
    await expect(readOmsSelectionSession(randomUUID(), { ...options, sessionsRoot: linkedRoot })).rejects.toMatchObject({ code: "SESSION_UNSAFE" });
    const created = await createOmsSelectionSession({ notePath: "Notes/a.md", selection: selection() }, options);
    const record = recordFile(options, created.sessionId);
    const outside = path.join(root, "outside.json");
    await rm(record);
    await writeFile(outside, "{}\n");
    await symlink(outside, record);
    await expect(readOmsSelectionSession(created.sessionId, options)).rejects.toMatchObject({ code: "SESSION_UNSAFE" });
    await rm(record);
    await writeFile(record, await readFile(outside));
    await link(record, path.join(root, "hardlinked.json"));
    await expect(readOmsSelectionSession(created.sessionId, options)).rejects.toMatchObject({ code: "SESSION_UNSAFE" });
    expect(await readFile(path.join(vault, "owned.md"), "utf8")).toBe("vault-owned\n");
  });

  it("publishes concurrent creates as independent private complete files", async () => {
    const { vault, options } = await fixture();
    const before = await snapshot(vault);
    const created = await Promise.all(Array.from({ length: 8 }, (_, index) => createOmsSelectionSession({
      notePath: `Notes/item-${index}.md`,
      selection: selection({ policyRevision: index, headingBindings: { topic: `Topic ${index}` } }),
    }, options)));
    expect(new Set(created.map(item => item.sessionId)).size).toBe(created.length);
    const names = await readdir(path.join(options.sessionsRoot, CONNECTION));
    expect(names.filter(name => !name.startsWith("."))).toEqual(expect.arrayContaining(created.map(item => `${item.sessionId}.json`)));
    expect(names.every(name => name.endsWith(".json") || name.startsWith("."))).toBe(true);
    for (const item of created) {
      const file = recordFile(options, item.sessionId);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(file)).nlink).toBe(1);
      expect(await readOmsSelectionSession(item.sessionId, options)).toEqual(item);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(item);
    }
    expect(await snapshot(vault)).toBe(before);
  });

  it("refuses a world-readable record and does not copy ordinary notes", async () => {
    const { vault, options } = await fixture();
    const created = await createOmsSelectionSession({ notePath: "Notes/a.md", selection: selection() }, options);
    const file = recordFile(options, created.sessionId);
    await chmod(file, 0o644);
    await expect(readOmsSelectionSession(created.sessionId, options)).rejects.toMatchObject({ code: "SESSION_UNSAFE" });
    expect(await readdir(vault)).toEqual([".oms", "owned.md"]);
    expect(await readdir(path.join(vault, ".oms"))).toEqual(["template-policy.json"]);
  });
  it("expires a read without cleanup and keeps other connections and corrupt entries", async () => {
    const { options } = await fixture();
    const created = await createOmsSelectionSession({ notePath: "Notes/a.md", selection: selection() }, options);
    const file = recordFile(options, created.sessionId);
    const stored = JSON.parse(await readFile(file, "utf8")) as OmsSelectionSession;
    const expired = { ...stored, createdAt: new Date(Date.now() - SELECTION_SESSION_TTL_MS - 1_000).toISOString() };
    await writeFile(file, `${JSON.stringify(expired)}\n`);
    await expect(readOmsSelectionSession(created.sessionId, options)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(await readFile(file, "utf8")).toContain(expired.createdAt);
    const otherId = "33333333-3333-4333-8333-333333333333";
    const otherDir = path.join(options.sessionsRoot, otherId);
    await mkdir(otherDir, { mode: 0o700 });
    const otherFile = path.join(otherDir, `${randomUUID()}.json`);
    await writeFile(otherFile, "{\"keep\":true}\n", { mode: 0o600 });
    const corrupt = path.join(path.dirname(file), "notes.txt");
    await writeFile(corrupt, "preserve\n", { mode: 0o600 });
    await expect(createOmsSelectionSession({ notePath: "Notes/b.md", selection: selection() }, options)).rejects.toMatchObject({ code: "SESSION_RETAINED" });
    expect(await readFile(otherFile, "utf8")).toBe("{\"keep\":true}\n");
    expect(await readFile(corrupt, "utf8")).toBe("preserve\n");
    expect(await readFile(file, "utf8")).toContain(expired.createdAt);
  });

  it("drops only expired and oldest validated records when the connection cap is exceeded", async () => {
    const { options } = await fixture();
    const directory = path.join(options.sessionsRoot, CONNECTION);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const oldest = "00000000-0000-4000-8000-000000000001";
    const kept = "00000000-0000-4000-8000-000000000002";
    const base = await createOmsSelectionSession({ notePath: "Notes/base.md", selection: selection() }, options);
    const manual = (id: string, createdAt: string): OmsSelectionSession => ({ ...base, sessionId: id, createdAt, notePath: `Notes/${id}.md` });
    await writeFile(path.join(directory, `${oldest}.json`), `${JSON.stringify(manual(oldest, "2020-01-01T00:00:00.000Z"))}\n`, { mode: 0o600 });
    await writeFile(path.join(directory, `${kept}.json`), `${JSON.stringify(manual(kept, new Date().toISOString()))}\n`, { mode: 0o600 });
    for (let index = 0; index < SELECTION_SESSION_CAP - 1; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`;
      await writeFile(path.join(directory, `${id}.json`), `${JSON.stringify(manual(id, new Date(Date.now() - (index + 2) * 1000).toISOString()))}\n`, { mode: 0o600 });
    }
    const created = await createOmsSelectionSession({ notePath: "Notes/new.md", selection: selection() }, options);
    expect(await readOmsSelectionSession(created.sessionId, options)).toEqual(created);
    await expect(readFile(path.join(directory, `${oldest}.json`))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(path.join(directory, `${kept}.json`), "utf8"))).toMatchObject({ sessionId: kept });
    const names = (await readdir(directory)).filter(name => name.endsWith(".json"));
    expect(names).toHaveLength(SELECTION_SESSION_CAP);
  });
  it("preserves a copied UUID payload under another filename and a non-UUID name", async () => {
    const { options } = await fixture();
    const created = await createOmsSelectionSession({ notePath: "Notes/a.md", selection: selection() }, options);
    const directory = path.join(options.sessionsRoot, CONNECTION);
    const copiedId = "44444444-4444-4444-8444-444444444444";
    const copied = path.join(directory, `${copiedId}.json`);
    await writeFile(copied, await readFile(recordFile(options, created.sessionId)), { mode: 0o600 });
    const foreign = path.join(directory, "notes.txt");
    await writeFile(foreign, "preserve\n", { mode: 0o600 });
    await expect(createOmsSelectionSession({ notePath: "Notes/b.md", selection: selection() }, options)).rejects.toMatchObject({ code: "SESSION_RETAINED" });
    expect(await readFile(copied, "utf8")).toContain(created.sessionId);
    expect(await readFile(foreign, "utf8")).toBe("preserve\n");
    await expect(readOmsSelectionSession(copiedId, options)).rejects.toMatchObject({ code: "SESSION_INVALID" });
  });

  it("rejects an invalid connection id before creating the sessions root", async () => {
    const { sessionsRoot, options } = await fixture();
    await expect(createOmsSelectionSession({ notePath: "Notes/a.md", selection: selection() }, { ...options, connectionId: "not-a-uuid" })).rejects.toMatchObject({ code: "SESSION_INVALID" });
    expect(lstatSync(sessionsRoot, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("propagates directory sync failure and restores the scoped mock", async () => {
    const { options } = await fixture();
    const created = await createOmsSelectionSession({ notePath: "Notes/a.md", selection: selection() }, options);
    const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      const error = new Error("directory sync unsupported") as NodeJS.ErrnoException;
      error.code = "ENOTSUP";
      throw error;
    });
    syncBuiltinESMExports();
    try {
      await expect(createOmsSelectionSession({ notePath: "Notes/b.md", selection: selection() }, options)).rejects.toMatchObject({ code: "ENOTSUP" });
    } finally {
      fsync.mockRestore();
      syncBuiltinESMExports();
    }
    expect(await readOmsSelectionSession(created.sessionId, options)).toEqual(created);
  });
});
describe("selection session admission boundary", () => {
  it("preflights invalid input without creating a sessions directory", async () => {
    const { sessionsRoot, options } = await fixture();
    expect(() => validateOmsSelectionSessionInput({ notePath: "Notes/a.md", selection: selection() })).not.toThrow();
    expect(() => validateOmsSelectionSessionInput({ notePath: "../outside.md", selection: selection() })).toThrow(expect.objectContaining({ code: "SESSION_INVALID" }));
    expect(lstatSync(sessionsRoot, { throwIfNoEntry: false })).toBeUndefined();
    await expect(readdir(options.sessionsRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("distinguishes a wrong portable id or local root from a malformed record id", async () => {
    const { root, options } = await fixture();
    const created = await createOmsSelectionSession({ notePath: "Notes/a.md", selection: selection() }, options);
    const file = recordFile(options, created.sessionId);
    const stored = JSON.parse(await readFile(file, "utf8")) as OmsSelectionSession;
    await writeFile(file, `${JSON.stringify({ ...stored, vaultId: "55555555-5555-4555-8555-555555555555" })}\n`);
    await expect(readOmsSelectionSession(created.sessionId, options)).rejects.toMatchObject({ code: "SESSION_VAULT_MISMATCH" });
    const other = path.join(root, "other-vault");
    await mkdir(other);
    await writeFile(file, `${JSON.stringify(stored)}\n`);
    await expect(readOmsSelectionSession(created.sessionId, { ...options, vaultPath: other })).rejects.toMatchObject({ code: "SESSION_VAULT_MISMATCH" });
    await writeFile(file, `${JSON.stringify({ ...stored, connectionId: "not-a-uuid" })}\n`);
    await expect(readOmsSelectionSession(created.sessionId, options)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    await writeFile(file, `${JSON.stringify({ ...stored, vaultId: "copied-id" })}\n`);
    await expect(readOmsSelectionSession(created.sessionId, options)).rejects.toMatchObject({ code: "SESSION_INVALID" });
  });

  it("rejects a no-follow symlink, a hardlink, and a record changed during the bounded read", async () => {
    const { root, options } = await fixture();
    const created = await createOmsSelectionSession({ notePath: "Notes/a.md", selection: selection() }, options);
    const record = recordFile(options, created.sessionId);
    const outside = path.join(root, "outside.json");
    const bytes = await readFile(record);
    await rm(record);
    await writeFile(outside, bytes);
    await symlink(outside, record);
    const symlinkOpen = vi.spyOn(fs.promises, "open");
    syncBuiltinESMExports();
    try {
      await expect(readOmsSelectionSession(created.sessionId, options)).rejects.toMatchObject({ code: "SESSION_UNSAFE" });
      expect(symlinkOpen).not.toHaveBeenCalled();
    } finally {
      symlinkOpen.mockRestore();
      syncBuiltinESMExports();
    }
    await rm(record);
    await writeFile(record, bytes, { mode: 0o600 });
    await link(record, path.join(root, "hardlinked.json"));
    const hardlinkOpen = vi.spyOn(fs.promises, "open");
    syncBuiltinESMExports();
    try {
      await expect(readOmsSelectionSession(created.sessionId, options)).rejects.toMatchObject({ code: "SESSION_UNSAFE" });
      expect(hardlinkOpen).not.toHaveBeenCalled();
    } finally {
      hardlinkOpen.mockRestore();
      syncBuiltinESMExports();
    }
    await rm(path.join(root, "hardlinked.json"));
    const opened = vi.spyOn(fs.promises, "open").mockImplementation(((target: fs.PathLike, flags?: fs.OpenMode) => {
      if (String(target) === record) return Promise.reject(Object.assign(new Error("record changed before no-follow open"), { code: "ENOENT" }));
      return open(target, flags);
    }) as typeof fs.promises.open);
    syncBuiltinESMExports();
    try {
      await expect(readOmsSelectionSession(created.sessionId, options)).rejects.toMatchObject({ code: "SESSION_UNSAFE" });
      expect(opened.mock.calls.some(call => String(call[0]) === record && call[1] === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW))).toBe(true);
    } finally {
      opened.mockRestore();
      syncBuiltinESMExports();
    }
    expect(await readFile(record)).toEqual(bytes);
  });

  it("removes the owned record when the publication postcheck open fails", async () => {
    const { options } = await fixture();
    const kept = await createOmsSelectionSession({ notePath: "Notes/kept.md", selection: selection() }, options);
    const failure = installFsFailure("open", once(args => String(args[0]).endsWith(".json") && args[1] === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)));
    try {
      await expect(createOmsSelectionSession({ notePath: "Notes/postcheck.md", selection: selection() }, options)).rejects.toMatchObject({ code: "EIO" });
    } finally {
      failure.restore();
    }
    expect(await recordNames(options)).toEqual([`${kept.sessionId}.json`]);
  });

  it("removes the owned record when retention rejects an unrelated entry", async () => {
    const { options } = await fixture();
    const kept = await createOmsSelectionSession({ notePath: "Notes/kept.md", selection: selection() }, options);
    const directory = path.join(options.sessionsRoot, CONNECTION);
    await writeFile(path.join(directory, "notes.txt"), "preserve\n", { mode: 0o600 });
    await expect(createOmsSelectionSession({ notePath: "Notes/retention.md", selection: selection() }, options)).rejects.toMatchObject({ code: "SESSION_RETAINED" });
    expect(await readFile(path.join(directory, "notes.txt"), "utf8")).toBe("preserve\n");
    expect(await recordNames(options)).toEqual([`${kept.sessionId}.json`]);
  });

  it("removes the owned record when the final verified read fails after retention", async () => {
    const { options } = await fixture();
    const kept = await createOmsSelectionSession({ notePath: "Notes/kept.md", selection: selection() }, options);
    const keptBytes = await readFile(recordFile(options, kept.sessionId));
    const createdTargets = new Set<string>();
    let verifiedOpens = 0;
    const failure = installFsFailure("open", args => {
      const target = String(args[0]);
      const isVerifiedRead = target.endsWith(".json") && args[1] === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      if (!isVerifiedRead || target.endsWith(`${kept.sessionId}.json`)) return false;
      createdTargets.add(target);
      verifiedOpens += 1;
      return verifiedOpens === 4;
    });
    try {
      await expect(createOmsSelectionSession({ notePath: "Notes/final.md", selection: selection() }, options)).rejects.toMatchObject({ code: "EIO" });
    } finally {
      failure.restore();
    }
    expect(verifiedOpens).toBe(5);
    expect(createdTargets.size).toBe(1);
    expect(await recordNames(options)).toEqual([`${kept.sessionId}.json`]);
    expect(await readFile(recordFile(options, kept.sessionId))).toEqual(keptBytes);
  });

  it("reports cleanup uncertainty and preserves an external replacement", async () => {
    const { root, options } = await fixture();
    const kept = await createOmsSelectionSession({ notePath: "Notes/kept.md", selection: selection() }, options);
    const directory = path.join(options.sessionsRoot, CONNECTION);
    await writeFile(path.join(directory, "notes.txt"), "preserve\n", { mode: 0o600 });
    const removal = installFsFailure("rm", args => String(args[0]).endsWith(".json"));
    let uncertain: unknown;
    try {
      await createOmsSelectionSession({ notePath: "Notes/uncertain.md", selection: selection() }, options);
    } catch (error) {
      uncertain = error;
    } finally {
      removal.restore();
    }
    expect(uncertain).toMatchObject({ code: "SESSION_RECONCILIATION_UNCERTAIN", locator: { connectionId: CONNECTION, sessionsRoot: options.sessionsRoot } });
    expect(uncertain).toBeInstanceOf(OmsSessionError);
    const names = await recordNames(options);
    expect(names).toContain(`${kept.sessionId}.json`);
    expect(names).toHaveLength(2);
    const createdName = names.find(name => name !== `${kept.sessionId}.json`);
    expect(createdName).toBeDefined();
    const replacement = path.join(directory, createdName ?? "");
    await rm(replacement);
    const external = path.join(root, "external.json");
    await writeFile(external, "{\"replaced\":true}\n", { mode: 0o600 });
    await symlink(external, replacement);
    await writeFile(path.join(directory, "foreign.txt"), "preserve-foreign\n", { mode: 0o600 });
    await expect(createOmsSelectionSession({ notePath: "Notes/replaced.md", selection: selection() }, options)).rejects.toMatchObject({ code: "SESSION_RETAINED" });
    expect(lstatSync(replacement).isSymbolicLink()).toBe(true);
    expect(await readFile(external, "utf8")).toBe("{\"replaced\":true}\n");
    expect(await readFile(path.join(directory, "notes.txt"), "utf8")).toBe("preserve\n");
    expect(await readFile(path.join(directory, "foreign.txt"), "utf8")).toBe("preserve-foreign\n");
  });

  it("rejects creation and preserves foreign bytes when an expired victim is replaced before unlink", async () => {
    const { options } = await fixture();
    const kept = await createOmsSelectionSession({ notePath: "Notes/kept.md", selection: selection() }, options);
    const keptBytes = await readFile(recordFile(options, kept.sessionId));
    const directory = path.join(options.sessionsRoot, CONNECTION);
    const expiredId = "00000000-0000-4000-8000-0000000000e1";
    const expiredFile = path.join(directory, `${expiredId}.json`);
    const stored = JSON.parse(keptBytes.toString("utf8")) as OmsSelectionSession;
    await writeFile(expiredFile, `${JSON.stringify({ ...stored, sessionId: expiredId, createdAt: new Date(Date.now() - SELECTION_SESSION_TTL_MS - 1_000).toISOString(), notePath: "Notes/expired.md" })}\n`, { mode: 0o600 });
    const foreign = Buffer.from("expired-foreign-bytes\n");
    let classificationLstats = 0;
    let replaced = false;
    const original = fs.promises.lstat;
    const seam = vi.spyOn(fs.promises, "lstat").mockImplementation((async (target: fs.PathLike, options?: { bigint?: boolean }) => {
      const current = await original(target, options);
      if (String(target) === expiredFile && current.isFile() && current.nlink === 1 && (current.mode & 0o077) === 0) {
        classificationLstats += 1;
        if (!replaced && classificationLstats === 5) {
          replaced = true;
          await rm(expiredFile);
          await writeFile(expiredFile, foreign, { mode: 0o600 });
        }
      }
      return current;
    }) as typeof fs.promises.lstat);
    syncBuiltinESMExports();
    try {
      await expect(createOmsSelectionSession({ notePath: "Notes/expired-replacement.md", selection: selection() }, options)).rejects.toMatchObject({ code: "SESSION_RETAINED" });
    } finally {
      seam.mockRestore();
      syncBuiltinESMExports();
    }
    expect(replaced).toBe(true);
    expect(classificationLstats).toBe(9);
    expect(await readFile(expiredFile)).toEqual(foreign);
    expect((await stat(expiredFile)).nlink).toBe(1);
    expect(await readFile(recordFile(options, kept.sessionId))).toEqual(keptBytes);
    expect((await recordNames(options)).sort()).toEqual([`${expiredId}.json`, `${kept.sessionId}.json`].sort());
  });

  it("rejects creation and preserves foreign bytes when the overflow victim is replaced before unlink", async () => {
    const { options } = await fixture();
    const directory = path.join(options.sessionsRoot, CONNECTION);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const overflowId = "00000000-0000-4000-8000-000000000001";
    const base = await createOmsSelectionSession({ notePath: "Notes/base.md", selection: selection() }, options);
    const manual = (id: string, createdAt: string): OmsSelectionSession => ({ ...base, sessionId: id, createdAt, notePath: `Notes/${id}.md` });
    const overflowFile = path.join(directory, `${overflowId}.json`);
    await writeFile(overflowFile, `${JSON.stringify(manual(overflowId, new Date(Date.now() - SELECTION_SESSION_TTL_MS / 2).toISOString()))}\n`, { mode: 0o600 });
    for (let index = 0; index < SELECTION_SESSION_CAP - 2; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`;
      await writeFile(path.join(directory, `${id}.json`), `${JSON.stringify(manual(id, new Date(Date.now() - (index + 2) * 1000).toISOString()))}\n`, { mode: 0o600 });
    }
    const beforeNames = (await recordNames(options)).sort();
    expect(beforeNames).toHaveLength(SELECTION_SESSION_CAP);
    const foreign = Buffer.from("overflow-foreign-bytes\n");
    let classificationLstats = 0;
    let replaced = false;
    const original = fs.promises.lstat;
    const seam = vi.spyOn(fs.promises, "lstat").mockImplementation((async (target: fs.PathLike, options?: { bigint?: boolean }) => {
      const current = await original(target, options);
      if (String(target) === overflowFile && current.isFile() && current.nlink === 1 && (current.mode & 0o077) === 0) {
        classificationLstats += 1;
        if (!replaced && classificationLstats === 5) {
          replaced = true;
          await rm(overflowFile);
          await writeFile(overflowFile, foreign, { mode: 0o600 });
        }
      }
      return current;
    }) as typeof fs.promises.lstat);
    syncBuiltinESMExports();
    try {
      await expect(createOmsSelectionSession({ notePath: "Notes/overflow-replacement.md", selection: selection() }, options)).rejects.toMatchObject({ code: "SESSION_RETAINED" });
    } finally {
      seam.mockRestore();
      syncBuiltinESMExports();
    }
    expect(replaced).toBe(true);
    expect(classificationLstats).toBe(9);
    expect(await readFile(overflowFile)).toEqual(foreign);
    expect((await stat(overflowFile)).nlink).toBe(1);
    expect((await recordNames(options)).sort()).toEqual(beforeNames);
  });

  it("stops a connection scan at 129 entries before opening another record", async () => {
    const { options } = await fixture();
    const hidden = ".hidden-budget";
    const names = [hidden, ...Array.from({ length: 128 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}.json`), "00000000-0000-4000-8000-000000000129.json"];
    let reads = 0;
    let closed = false;
    const iterator = {
      async next(): Promise<IteratorResult<fs.Dirent>> {
        const name = names[reads];
        if (name === undefined) return { done: true, value: undefined };
        reads += 1;
        return { done: false, value: { name } as fs.Dirent };
      },
      async return(): Promise<IteratorResult<fs.Dirent>> {
        closed = true;
        return { done: true, value: undefined };
      },
    };
    const opened = vi.spyOn(fs.promises, "open");
    const directory = vi.spyOn(fs.promises, "opendir").mockImplementation((async () => ({
      [Symbol.asyncIterator]: () => iterator,
      close: async () => {
        if (closed) return;
        closed = true;
        await iterator.return();
      },
    })) as typeof fs.promises.opendir);
    syncBuiltinESMExports();
    let openedPaths: string[] = [];
    try {
      await expect(createOmsSelectionSession({ notePath: "Notes/budget.md", selection: selection() }, options)).rejects.toMatchObject({ code: "SESSION_RETAINED" });
    } finally {
      openedPaths = opened.mock.calls.map(args => String(args[0]));
      directory.mockRestore();
      opened.mockRestore();
      syncBuiltinESMExports();
    }
    expect(reads).toBe(129);
    expect(closed).toBe(true);
    expect(names[0]).toBe(hidden);
    expect(names.slice(0, reads)).toContain(hidden);
    const recordReads = openedPaths.filter(file => file.endsWith(".json"));
    expect(recordReads).toHaveLength(2);
    expect(new Set(recordReads).size).toBe(1);
    expect(openedPaths.some(file => names.some(name => file.endsWith(`/${name}`)))).toBe(false);
    expect(await recordNames(options)).toEqual([]);
  });
});
