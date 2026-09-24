import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { chmod, link, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionRegistryPath, readConnectionRegistry, reserveVaultConnection } from "../install/connection-registry.js";
import { digestBytes } from "./canonical.js";
import { parseContractPolicyV5, serializeContractPolicyV5, type ContractPolicyV5 } from "./contract-v5.js";
import { acknowledgeContractSource, checkContract, diagnoseContract, publishContract, relinkContractSource, reviewContractSources, selectContract, type ContractServiceOptions, type SelectContractResult } from "./service.js";
import { serializeVaultSettings, type VaultSettings } from "./vault-settings.js";
import { v3Bundle, v4Bundle, v4Policy, type HistoricalBundle } from "../../../test/fixtures/legacy-publication-builders.js";

const roots: string[] = [];
const restorers: Array<() => void> = [];
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";
const UPPER_ID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const markdown = "<%* throw new Error('must not execute') %>\n## Details\n{{agent-owned}}\n";
const otherMarkdown = "## Other\nUnrelated source.\n";

function temporary(name: string): string {
  const created = mkdtempSync(path.join(tmpdir(), `${name}-`));
  const root = realpathSync(created);
  roots.push(root);
  return root;
}

function policy(revision = 1): ContractPolicyV5 {
  return {
    version: 5,
    revision,
    properties: { status: { type: "text" }, tags: { type: "tags" } },
    common: { status: "active", fields: { status: { required: true } }, headings: [{ headingId: "details", title: "Details", level: 2 }] },
    templates: {
      flower: {
        status: "active",
        fields: { tags: { required: true } },
        headings: [{ headingId: "topic", binding: "topic", level: 2 }],
        source: { identity: "source-flower", path: "Templates/flower.md", rawDigest: digestBytes(markdown) },
      },
      other: {
        status: "active",
        fields: {},
        source: { identity: "source-other", path: "Templates/other.md", rawDigest: digestBytes(otherMarkdown) },
      },
    },
  };
}

function settings(vaultId = ID_B): VaultSettings {
  return { version: 1, vaultId, templateRoots: ["Templates"] };
}

async function writeVault(root: string, vaultId = ID_B, current = policy()): Promise<string> {
  const vault = path.join(root, "vault-a");
  await mkdir(path.join(vault, ".oms"), { recursive: true });
  await mkdir(path.join(vault, "Templates"), { recursive: true });
  await mkdir(path.join(vault, "Notes"), { recursive: true });
  await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings(settings(vaultId)));
  await writeFile(path.join(vault, ".oms", "template-policy.json"), serializeContractPolicyV5(current));
  await writeFile(path.join(vault, "Templates", "flower.md"), markdown);
  await writeFile(path.join(vault, "Templates", "other.md"), otherMarkdown);
  await writeFile(path.join(vault, "Notes", "saved.md"), "---\nstatus: open\ntags:\n  - flower\nunknown: kept\n---\n## Budget\nBody\n");
  return realpathSync(vault);
}

async function fixture() {
  const root = temporary("oms-contract-service");
  const vault = await writeVault(root);
  const runtime = path.join(root, "runtime");
  const registry = path.join(root, "config", "vault.json");
  const options: ContractServiceOptions = { registryPath: registry, runtimeRoot: runtime, homeDir: path.join(root, "home"), env: {} };
  return { root, vault, runtime, registry, options };
}

async function tree(directory: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute);
      if (entry.isSymbolicLink()) found[relative] = "symlink";
      else if (entry.isFIFO()) found[relative] = "fifo";
      else if (entry.isDirectory()) await walk(absolute);
      else found[relative] = (await readFile(absolute)).toString("base64");
    }
  }
  await walk(directory);
  return found;
}

function sessionFiles(snapshot: Record<string, string>): string[] {
  return Object.keys(snapshot).filter(name => name.includes(`${path.join("sessions", "v1")}${path.sep}`) && name.endsWith(".json"));
}

async function select(vault: string, options: ContractServiceOptions, templateId: string | null = "flower", notePath = "Notes/saved.md"): Promise<Extract<SelectContractResult, { state: "selected" }>> {
  const result = await selectContract({ target: { vault, source: "explicit" }, notePath, templateId, headingBindings: templateId === "flower" ? { topic: "Budget" } : {} }, options);
  if (result.state !== "selected") throw new Error(result.state);
  return result;
}

function duringSavedNoteRead(note: string, mutate: () => Promise<void>): () => void {
  const original = fs.promises.open;
  let pending = false;
  const spy = vi.spyOn(fs.promises, "open").mockImplementation(async (file, ...rest) => {
    const handle = await original(file, ...rest);
    if (path.resolve(String(file)) !== path.resolve(note)) return handle;
    const read = handle.read.bind(handle);
    handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
      if (!pending) {
        pending = true;
        await mutate();
      }
      return read(...readArgs);
    }) as typeof handle.read;
    return handle;
  });
  syncBuiltinESMExports();
  const restore = () => {
    spy.mockRestore();
    syncBuiltinESMExports();
  };
  restorers.push(restore);
  return restore;
}

afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("selection admission", () => {
  it("rejects an unadmitted target before reservation or session creation", async () => {
    const { vault, root, options } = await fixture();
    await expect(selectContract({ target: { vault, source: "cwd" }, notePath: "Notes/saved.md", templateId: null }, options)).rejects.toMatchObject({ code: "SELECTION_INVALID" });
    expect(lstatSync(path.join(root, "runtime"), { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(path.join(root, "config"), { throwIfNoEntry: false })).toBeUndefined();
  });
});

describe("V5 contract selection service", () => {
  it("persists only allowlisted session metadata and returns transient selected data", async () => {
    const { vault, runtime, options } = await fixture();
    const created = await select(vault, options);
    expect(created.locator.connectionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.selected.source?.text).toContain("must not execute");
    expect(created.selected.binding).toMatchObject({ templateId: "flower", sourceIdentity: "source-flower", sourcePath: "Templates/flower.md" });
    const files = sessionFiles(await tree(runtime));
    expect(files).toHaveLength(1);
    const stored = JSON.parse(Buffer.from(await tree(runtime).then(value => value[files[0]!] ?? "", "base64"), "base64").toString("utf8")) as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual(["version", "sessionId", "createdAt", "connectionId", "vaultId", "vaultFingerprint", "notePath", "selection"]);
    expect(Object.keys(stored["selection"] as object)).toEqual(["version", "templateId", "policyRevision", "contractDigest", "sourceDigest", "sourceIdentity", "sourcePath", "headingBindings"]);
    expect(JSON.stringify(stored)).not.toContain("must not execute");
    expect(JSON.stringify(stored)).not.toContain("Body");
  });

  it("selects common for explicit null and rejects an omitted template id before creating a session", async () => {
    const { vault, runtime, options } = await fixture();
    const common = await select(vault, options, null);
    expect(common.selected.binding).toMatchObject({ templateId: null, sourceIdentity: null, sourcePath: null, sourceDigest: null });
    expect(common.selected.source).toBeNull();
    const before = await tree(runtime);
    await expect(selectContract({ target: { vault, source: "explicit" }, notePath: "Notes/saved.md" } as never, options)).rejects.toMatchObject({ code: "SELECTION_INVALID" });
    expect(sessionFiles(await tree(runtime))).toEqual(sessionFiles(before));
  });

  it("fails closed before reservation when persisted bindings are not already exact", async () => {
    const { vault, runtime, registry, options } = await fixture();
    const before = await tree(runtime);
    await expect(selectContract({ target: { vault, source: "explicit" }, notePath: "Notes/saved.md", templateId: "flower", headingBindings: { topic: " Budget " } }, options)).rejects.toBeInstanceOf(Error);
    expect(await tree(runtime)).toEqual(before);
    expect(lstatSync(path.dirname(registry), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("does not create a session when the chosen source has drifted", async () => {
    const { vault, runtime, options } = await fixture();
    await writeFile(path.join(vault, "Templates", "flower.md"), `${markdown}\nchanged\n`);
    const before = await tree(runtime);
    await expect(select(vault, options)).rejects.toMatchObject({ code: "SOURCE_DRIFT" });
    expect(sessionFiles(await tree(runtime))).toEqual(sessionFiles(before));
  });

  it("keeps a stable A reservation while a v1 B pointer stays untouched after B is already unavailable", async () => {
    const { root, vault, registry, options } = await fixture();
    const vaultB = path.join(root, "vault-b");
    await mkdir(vaultB);
    await writeFile(path.join(vaultB, "secret.txt"), "secret-b");
    const pointer = `${JSON.stringify({ version: 1, vault: vaultB, signature: createHash("sha256").update(`oms-host-vault-pointer\n1\n${vaultB}\n`).digest("hex") })}\n`;
    await mkdir(path.dirname(registry), { recursive: true });
    await writeFile(registry, pointer);
    await rm(vaultB, { recursive: true, force: true });
    expect(lstatSync(vaultB, { throwIfNoEntry: false })).toBeUndefined();
    const first = await select(vault, options);
    expect(await readFile(registry, "utf8")).toBe(pointer);
    const second = await select(vault, options);
    expect(second.locator.connectionId).toBe(first.locator.connectionId);
    expect(await readFile(registry, "utf8")).toBe(pointer);
    const checked = await checkContract({ vault, locator: first.locator }, options);
    expect(checked.result).toMatchObject({ valid: true, structural: "pass", semantic: "not-evaluated" });
    expect(await readFile(registry, "utf8")).toBe(pointer);
    expect(lstatSync(vaultB, { throwIfNoEntry: false })).toBeUndefined();
    expect((await readConnectionRegistry(options)).state).toBe("v1");
  });

  it("fails before session publication when the reserved connection id is not lowercase", async () => {
    const { vault, runtime, registry, options } = await fixture();
    const reserved = await reserveVaultConnection({ vault, source: "explicit" }, { ...options, createId: () => UPPER_ID });
    expect(reserved.connectionId).toBe(UPPER_ID);
    const before = await tree(runtime);
    await expect(select(vault, options)).rejects.toMatchObject({ code: "SELECTION_INVALID" });
    expect(await tree(runtime)).toEqual(before);
    await expect(readFile(registry, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks the persisted note without a registry lookup and preserves unknown fields", async () => {
    const { vault, registry, options } = await fixture();
    const created = await select(vault, options);
    await rm(path.dirname(registry), { recursive: true, force: true });
    const note = path.join(vault, "Notes", "saved.md");
    const before = await readFile(note);
    const checked = await checkContract({ vault, locator: created.locator }, options);
    expect(checked.result).toMatchObject({ valid: true, structural: "pass", semantic: "not-evaluated" });
    expect(await readFile(note)).toEqual(before);
    expect(lstatSync(registry, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("reports structural failure without requiring a template property or evaluating semantics", async () => {
    const { vault, options } = await fixture();
    const created = await select(vault, options);
    const note = "---\nstatus: open\nfree: kept\n---\n## Other\n```\n## Budget\n```\n";
    await writeFile(path.join(vault, "Notes", "saved.md"), note);
    const checked = await checkContract({ vault, locator: created.locator }, options);
    expect(checked.result.structural).toBe("fail");
    expect(checked.result.semantic).toBe("not-evaluated");
    expect(checked.result.violations.map(item => item.rule)).toEqual(expect.arrayContaining(["required", "heading"]));
    expect(await readFile(path.join(vault, "Notes", "saved.md"), "utf8")).toBe(note);
  });

  it("distinguishes missing, expired, wrong-vault, wrong-copy, and wrong-locator outcomes", async () => {
    const { root, vault, runtime, options } = await fixture();
    const created = await select(vault, options);
    const other = await writeVault(path.join(root, "other-parent"), ID_C);
    await expect(checkContract({ vault: other, locator: created.locator }, options)).rejects.toMatchObject({ code: "SESSION_VAULT_MISMATCH" });
    const restoredParent = path.join(root, "restored-parent");
    const restored = await writeVault(restoredParent, ID_B);
    await expect(checkContract({ vault: restored, locator: created.locator }, options)).rejects.toMatchObject({ code: "SESSION_VAULT_MISMATCH" });
    await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings(settings(ID_C)));
    await expect(checkContract({ vault, locator: created.locator }, options)).rejects.toMatchObject({ code: "SESSION_VAULT_MISMATCH" });
    await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings(settings(ID_B)));
    const record = path.join(runtime, "sessions", "v1", created.locator.connectionId, `${created.locator.sessionId}.json`);
    const raw = JSON.parse(await readFile(record, "utf8")) as { createdAt: string };
    raw.createdAt = "2000-01-01T00:00:00.000Z";
    const expired = `${JSON.stringify(raw)}\n`;
    await writeFile(record, expired);
    await expect(checkContract({ vault, locator: created.locator }, options)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(await readFile(record, "utf8")).toBe(expired);
    await expect(checkContract({ vault, locator: { ...created.locator, connectionId: ID_A } }, options)).rejects.toMatchObject({ code: "SELECTION_MISSING" });
    await rm(path.join(vault, ".oms", "settings.json"));
    await expect(checkContract({ vault, locator: created.locator }, options)).rejects.toMatchObject({ code: "VAULT_SETTINGS_MISSING" });
  });

  it("requires reselection for chosen drift and global revision, but not unrelated source drift", async () => {
    const { vault, options } = await fixture();
    const created = await select(vault, options);
    await writeFile(path.join(vault, "Templates", "other.md"), `${otherMarkdown}\nchanged\n`);
    expect((await checkContract({ vault, locator: created.locator }, options)).result.valid).toBe(true);
    await writeFile(path.join(vault, "Templates", "flower.md"), `${markdown}\nchanged\n`);
    await expect(checkContract({ vault, locator: created.locator }, options)).rejects.toMatchObject({ code: "RESELECT_REQUIRED" });
    await writeFile(path.join(vault, "Templates", "flower.md"), markdown);
    const next = policy(2);
    await writeFile(path.join(vault, ".oms", "template-policy.json"), serializeContractPolicyV5(next));
    await expect(checkContract({ vault, locator: created.locator }, options)).rejects.toMatchObject({ code: "RESELECT_REQUIRED" });
  });

  it("rejects an externally injected policy or source change during the saved-note read", async () => {
    const { vault, runtime, registry, options } = await fixture();
    const created = await select(vault, options);
    const note = path.join(vault, "Notes", "saved.md");
    const policyPath = path.join(vault, ".oms", "template-policy.json");
    const sourcePath = path.join(vault, "Templates", "flower.md");
    const settingsPath = path.join(vault, ".oms", "settings.json");
    const record = path.join(runtime, "sessions", "v1", created.locator.connectionId, `${created.locator.sessionId}.json`);
    const before = {
      note: await readFile(note),
      policy: await readFile(policyPath),
      source: await readFile(sourcePath),
      settings: await readFile(settingsPath),
      session: await readFile(record),
      registry: lstatSync(registry, { throwIfNoEntry: false }) === undefined ? null : await readFile(registry),
    };
    const current = policy();
    const flower = current.templates.flower;
    if (flower.status !== "active") throw new Error("fixture");
    const tightened: ContractPolicyV5 = { ...current, templates: { ...current.templates, flower: { ...flower, fields: { tags: { required: false } } } } };
    const cases = [
      { label: "revision", write: () => writeFile(policyPath, serializeContractPolicyV5(policy(2))) },
      { label: "required-field", write: () => writeFile(policyPath, serializeContractPolicyV5(tightened)) },
      { label: "selected-source", write: () => writeFile(sourcePath, `${markdown}\nexternally changed\n`) },
      { label: "source-identity", write: () => {
        const renamed = policy();
        const entry = renamed.templates.flower;
        if (entry.status !== "active") throw new Error("fixture");
        const next: ContractPolicyV5 = { ...renamed, templates: { ...renamed.templates, flower: { ...entry, source: { ...entry.source, identity: "source-renamed" } } } };
        return writeFile(policyPath, serializeContractPolicyV5(next));
      } },
      { label: "source-path", write: async () => {
        const relocated = policy();
        const entry = relocated.templates.flower;
        if (entry.status !== "active") throw new Error("fixture");
        await writeFile(path.join(vault, "Templates", "copy.md"), markdown);
        const next: ContractPolicyV5 = { ...relocated, templates: { ...relocated.templates, flower: { ...entry, source: { ...entry.source, path: "Templates/copy.md" } } } };
        await writeFile(policyPath, serializeContractPolicyV5(next));
      } },
    ] as const;
    for (const item of cases) {
      await writeFile(policyPath, before.policy);
      await writeFile(sourcePath, before.source);
      const restore = duringSavedNoteRead(note, item.write);
      try {
        await expect(checkContract({ vault, locator: created.locator }, options), item.label).rejects.toMatchObject({ code: "RESELECT_REQUIRED" });
      } finally {
        restore();
      }
      expect(await readFile(note), item.label).toEqual(before.note);
      expect(await readFile(record), item.label).toEqual(before.session);
      expect(lstatSync(registry, { throwIfNoEntry: false }) === undefined ? null : await readFile(registry), item.label).toEqual(before.registry);
    }
    await writeFile(policyPath, before.policy);
    await writeFile(sourcePath, before.source);
    const unchanged = duringSavedNoteRead(note, async () => {
      await writeFile(path.join(vault, "Templates", "other.md"), `${otherMarkdown}\nexternally changed\n`);
    });
    try {
      expect((await checkContract({ vault, locator: created.locator }, options)).result).toMatchObject({ valid: true, structural: "pass", semantic: "not-evaluated" });
    } finally {
      unchanged();
    }
    const identity = duringSavedNoteRead(note, () => writeFile(settingsPath, serializeVaultSettings(settings(ID_C))));
    try {
      await expect(checkContract({ vault, locator: created.locator }, options)).rejects.toMatchObject({ code: "SELECTION_UNSAFE" });
    } finally {
      identity();
    }
    expect(await readFile(note)).toEqual(before.note);
    expect(await readFile(record)).toEqual(before.session);
    expect(await readFile(settingsPath)).not.toEqual(before.settings);
  });

  it("rejects caller selection overrides and does not read another connection", async () => {
    const { vault, options } = await fixture();
    const created = await select(vault, options);
    await expect(checkContract({ vault, locator: created.locator, selection: { templateId: null } } as never, options)).rejects.toMatchObject({ code: "SELECTION_INVALID" });
    await expect(checkContract({ vault, locator: created.locator, notePath: "Notes/other.md" } as never, options)).rejects.toMatchObject({ code: "SELECTION_INVALID" });
  });

  it("fails closed for symlink, hardlink, FIFO, and invalid UTF-8 without rewriting the note", async () => {
    const { root, vault, options } = await fixture();
    const created = await select(vault, options);
    const note = path.join(vault, "Notes", "saved.md");
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "outside");
    await rm(note);
    await symlink(outside, note);
    await expect(checkContract({ vault, locator: created.locator }, options)).rejects.toMatchObject({ code: "NOTE_UNSAFE" });
    await rm(note);
    await link(outside, note);
    await expect(checkContract({ vault, locator: created.locator }, options)).rejects.toMatchObject({ code: "NOTE_UNSAFE" });
    await rm(note);
    execFileSync("mkfifo", [note]);
    await expect(checkContract({ vault, locator: created.locator }, options)).rejects.toMatchObject({ code: "NOTE_UNSAFE" });
    expect(lstatSync(note).isFIFO()).toBe(true);
    await rm(note);
    await writeFile(note, Buffer.from([0xff, 0xfe, 0xfd]));
    await expect(checkContract({ vault, locator: created.locator }, options)).rejects.toMatchObject({ code: "NOTE_UNSAFE" });
  });

  it("keeps a BOM and undeclared non-JSON parser values, and reports a declared invalid type", async () => {
    const { vault, options } = await fixture();
    const created = await select(vault, options);
    const note = path.join(vault, "Notes", "saved.md");
    const preserved = "\ufeff---\nstatus: open\ntags:\n  - flower\nwhen: 2024-01-02 03:04:05\nratio: .nan\n---\n## Budget\nBody\n";
    await writeFile(note, preserved);
    const checked = await checkContract({ vault, locator: created.locator }, options);
    expect(checked.result).toMatchObject({ valid: true, structural: "pass", semantic: "not-evaluated" });
    expect(await readFile(note, "utf8")).toBe(preserved);
    const declared = "---\nstatus: open\ntags: 2024-01-02 03:04:05\n---\n## Budget\n";
    await writeFile(note, declared);
    const failed = await checkContract({ vault, locator: created.locator }, options);
    expect(failed.result).toMatchObject({ valid: false, structural: "fail", semantic: "not-evaluated" });
    expect(failed.result.violations.map(item => item.rule)).toContain("type");
    expect(await readFile(note, "utf8")).toBe(declared);
  });

  it("does not change vault or session bytes during a valid or failing check", async () => {
    const { vault, runtime, options } = await fixture();
    const created = await select(vault, options);
    const beforeVault = await tree(vault);
    const beforeRuntime = await tree(runtime);
    await checkContract({ vault, locator: created.locator }, options);
    expect(await tree(vault)).toEqual(beforeVault);
    expect(await tree(runtime)).toEqual(beforeRuntime);
    await chmod(path.join(vault, "Notes", "saved.md"), 0o000);
    await expect(checkContract({ vault, locator: created.locator }, options)).rejects.toThrow();
    await chmod(path.join(vault, "Notes", "saved.md"), 0o644);
    expect(await tree(vault)).toEqual(beforeVault);
    expect(await tree(runtime)).toEqual(beforeRuntime);
  });

  it("canonicalizes a public vault alias onto the same reservation", async () => {
    const { root, vault, runtime, options } = await fixture();
    const alias = path.join(root, "vault-alias");
    await symlink(vault, alias);
    const selected = await select(alias, options);
    const direct = await select(vault, options);
    expect(direct.locator.connectionId).toBe(selected.locator.connectionId);
    expect(await readdir(path.join(runtime, "connection-reservations", "v1"))).toHaveLength(1);
    const checked = await checkContract({ vault: alias, locator: selected.locator }, options);
    expect(checked.notePath).toBe("Notes/saved.md");
  });

  it("rejects an unsafe sessions root override instead of accepting a normalized location", async () => {
    const { root, vault, runtime, options } = await fixture();
    const alias = path.join(root, "sessions-alias");
    await mkdir(path.join(runtime, "sessions", "v1"), { recursive: true });
    await symlink(path.join(runtime, "sessions", "v1"), alias);
    await expect(select(vault, { ...options, sessionsRoot: alias })).rejects.toMatchObject({ code: "SELECTION_UNSAFE" });
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
  });
});
const OP = "44444444-4444-4444-8444-444444444444";
const TX = "55555555-5555-4555-8555-555555555555";
const OTHER_TX = "66666666-6666-4666-8666-666666666666";

async function installLegacy(vault: string, bundle: HistoricalBundle, source = ""): Promise<void> {
  const files: Record<string, Uint8Array> = { [bundle.markerPath]: bundle.markerBytes, [bundle.planPath]: bundle.planBytes, ...bundle.observed };
  const templates = JSON.parse(Buffer.from(bundle.policy).toString("utf8")).templates as Record<string, { source?: { path?: string } }> | undefined;
  for (const template of Object.values(templates ?? {})) if (template.source?.path !== undefined) files[template.source.path] = Buffer.from(source);
  for (const [relative, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(vault, relative)), { recursive: true });
    await writeFile(path.join(vault, relative), bytes);
  }
}

function migrationInput(vault: string, migration: { operationId: string; transactionId: string; vaultId: string } = { operationId: OP, transactionId: TX, vaultId: ID_A }, templateId: string | null = null) {
  return { target: { vault, source: "explicit" as const }, notePath: "Notes/saved.md", templateId, headingBindings: {}, migration };
}

describe("on-use legacy contract selection", () => {
  it("holds duplicate historical and V5 version members without creating or refreshing a selection", async () => {
    const { root, vault, options } = await fixture();
    const created = await select(vault, options);
    const file = path.join(vault, ".oms", "template-policy.json");
    const original = await readFile(file, "utf8");
    await writeFile(file, `{"version":4,${original.trim().slice(1)}`);
    const before = await tree(root);
    const held = await selectContract(migrationInput(vault), options);
    expect(held.state).toBe("review-required");
    if (held.state === "review-required") expect(held.reasons.join(" ")).toContain("ambiguous");
    await expect(checkContract({ vault, locator: created.locator }, options)).rejects.toMatchObject({ code: "CONTRACT_POLICY_INVALID" });
    expect(await tree(root)).toEqual(before);
  });

  it("migrates genuine V3 and empty-source V4 only after input validation, then selects common", async () => {
    for (const bundle of [v3Bundle(), v4Bundle(v4Policy(""), {})]) {
      const { root, registry, runtime, options } = await fixture();
      const vault = path.join(root, "legacy");
      await mkdir(vault);
      await installLegacy(vault, bundle);
      await mkdir(path.join(vault, "Notes"), { recursive: true });
      await writeFile(path.join(vault, "Notes", "saved.md"), "---\nstatus: open\n---\n");
      const beforeNote = await readFile(path.join(vault, "Notes", "saved.md"));
      const sourcePath = path.join(vault, "Templates", "note.md");
      const beforeSource = lstatSync(sourcePath, { throwIfNoEntry: false }) === undefined ? null : await readFile(sourcePath);
      const selected = await selectContract(migrationInput(vault), options);
      expect(selected.state).toBe("selected");
      if (selected.state !== "selected") throw new Error(selected.state);
      expect(selected.selected.binding.templateId).toBeNull();
      expect(selected.migration?.sessionLimit).toContain("not one atomic receipt");
      const published = parseContractPolicyV5(await readFile(path.join(vault, ".oms", "template-policy.json"), "utf8"));
      expect(published.version).toBe(5);
      expect(await readFile(path.join(vault, ".oms", "history", "contracts", `${published.revision}.json`), "utf8")).toContain(TX);
      expect(JSON.parse(await readFile(path.join(vault, ".oms", "settings.json"), "utf8")).vaultId).toBe(ID_A);
      expect(await readFile(path.join(vault, ".oms", "migrations", TX, "complete-receipt.json"), "utf8")).toContain("complete");
      expect(await readFile(path.join(vault, "Notes", "saved.md"))).toEqual(beforeNote);
      if (beforeSource !== null) expect(await readFile(sourcePath)).toEqual(beforeSource);
      expect(await readFile(registry, "utf8")).toContain(vault);
      expect(sessionFiles(await tree(runtime))).toHaveLength(1);
    }
  });

  it("returns review-required for held nonempty V4 without writes", async () => {
    const { root, registry, runtime, options } = await fixture();
    const held = path.join(root, "held");
    await mkdir(held);
    await installLegacy(held, v4Bundle(v4Policy("# guidance"), {}), "# guidance");
    const before = await tree(held);
    const result = await selectContract(migrationInput(held), options);
    expect(result.state).toBe("review-required");
    if (result.state === "review-required") {
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain("base64");
    }
    expect(await tree(held)).toEqual(before);
    expect(lstatSync(runtime, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(path.dirname(registry), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("rejects an invalid tuple, template, binding, note, and unsafe runtime before effects", async () => {
    const { vault, root, options } = await fixture();
    const before = await tree(vault);
    await expect(selectContract({ ...migrationInput(vault), migration: { operationId: UPPER_ID, transactionId: TX, vaultId: ID_A } }, options)).rejects.toMatchObject({ code: "SELECTION_INVALID" });
    await expect(selectContract({ ...migrationInput(vault), templateId: "../flower" }, options)).rejects.toThrow();
    await expect(selectContract({ ...migrationInput(vault), headingBindings: { topic: " Budget " } }, options)).rejects.toThrow();
    await expect(selectContract({ ...migrationInput(vault), notePath: "../outside.md" }, options)).rejects.toThrow();
    await expect(selectContract(migrationInput(vault), { ...options, runtimeRoot: vault })).rejects.toMatchObject({ code: "SELECTION_UNSAFE" });
    expect(await tree(vault)).toEqual(before);
    expect(lstatSync(path.join(root, "runtime"), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("accepts a valid env-resolved registry path and refuses only an unsafe resolved path", async () => {
    const { root, options } = await fixture();
    const vault = path.join(root, "implicit");
    await mkdir(vault);
    await installLegacy(vault, v3Bundle());
    const registry = connectionRegistryPath({ XDG_CONFIG_HOME: path.join(root, "xdg") }, path.join(root, "home"));
    const selected = await selectContract(migrationInput(vault), { runtimeRoot: options.runtimeRoot, homeDir: path.join(root, "home"), env: { XDG_CONFIG_HOME: path.join(root, "xdg") } });
    expect(selected.state).toBe("selected");
    expect(lstatSync(registry).isFile()).toBe(true);
    const inside = path.join(vault, "inside-registry.json");
    await expect(selectContract(migrationInput(vault), { ...options, registryPath: inside })).rejects.toMatchObject({ code: "SELECTION_UNSAFE" });
    expect(lstatSync(inside, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("returns an explicit result for an unknown selection before commit", async () => {
    const { root, runtime, options } = await fixture();
    const vault = path.join(root, "unknown-selection");
    await mkdir(vault);
    await installLegacy(vault, v3Bundle());
    const before = await tree(vault);
    const result = await selectContract(migrationInput(vault, undefined, "missing"), options);
    expect(result.state).toBe("review-required");
    expect(await tree(vault)).toEqual(before);
    expect(sessionFiles(await tree(runtime))).toEqual([]);
  });

  it("returns pending after an actual native publication fault and resumes the original ids", async () => {
    const { root, runtime, options } = await fixture();
    const vault = path.join(root, "fault");
    await mkdir(vault);
    await installLegacy(vault, v3Bundle());
    let reached = false;
    const faulted = await selectContract(migrationInput(vault), { ...options, publicationFault: point => { if (point === "after-plan") { reached = true; throw new Error("native after-plan"); } } });
    expect(reached).toBe(true);
    expect(faulted.state).toBe("migration-pending");
    expect(lstatSync(path.join(vault, ".oms", "migrations", TX, "plan.json")).isFile()).toBe(true);
    expect(lstatSync(path.join(vault, ".oms", "migrations", TX, "complete-receipt.json"), { throwIfNoEntry: false })).toBeUndefined();
    const resumed = await selectContract(migrationInput(vault), options);
    expect(resumed.state).toBe("selected");
    if (resumed.state === "selected") expect(resumed.migration).toMatchObject({ operationId: OP, transactionId: TX, vaultId: ID_A });
    expect(sessionFiles(await tree(runtime))).toHaveLength(1);
  });

  it("refuses a stale same-root tuple before another publication", async () => {
    const { root, options } = await fixture();
    const vault = path.join(root, "stale");
    await mkdir(vault);
    await installLegacy(vault, v4Bundle(v4Policy(""), {}));
    await selectContract(migrationInput(vault), options);
    const before = await tree(vault);
    await expect(selectContract(migrationInput(vault, { operationId: OP, transactionId: OTHER_TX, vaultId: ID_A }), options)).rejects.toMatchObject({ code: "SELECTION_INVALID" });
    expect(await tree(vault)).toEqual(before);
  });
  it("refuses a sealed-plan tuple mismatch and unknown template before resume effects", async () => {
    const { root, runtime, options } = await fixture();
    const vault = path.join(root, "sealed-mismatch");
    await mkdir(vault);
    await installLegacy(vault, v3Bundle());
    await selectContract(migrationInput(vault), { ...options, coordinatorFault: "after-vault-publication" });
    const plan = await readFile(path.join(vault, ".oms", "migrations", TX, "plan.json"));
    const sessions = sessionFiles(await tree(runtime));
    await expect(selectContract(migrationInput(vault, { operationId: OP, transactionId: OTHER_TX, vaultId: ID_A }), options)).rejects.toMatchObject({ code: "SELECTION_INVALID" });
    const unknown = await selectContract(migrationInput(vault, undefined, "missing"), options);
    expect(unknown.state).toBe("review-required");
    expect(await readFile(path.join(vault, ".oms", "migrations", TX, "plan.json"))).toEqual(plan);
    expect(sessionFiles(await tree(runtime))).toEqual(sessions);
  });

  it("does not create a session when the published source drifts after vault completion", async () => {
    const { root, runtime, options } = await fixture();
    const vault = path.join(root, "drift");
    await mkdir(vault);
    await installLegacy(vault, v4Bundle(v4Policy(""), {}));
    await selectContract(migrationInput(vault), { ...options, coordinatorFault: "after-global-upsert" });
    const before = sessionFiles(await tree(runtime));
    await writeFile(path.join(vault, "Templates", "note.md"), "drifted");
    const drifted = await selectContract(migrationInput(vault, undefined, "note"), options);
    expect(drifted.state).toBe("review-required");
    if (drifted.state === "review-required") expect(drifted.reasons.join(" ")).toContain("SOURCE_DRIFT");
    expect(sessionFiles(await tree(runtime))).toEqual(before);
  });

  it("keeps checkContract read-only against legacy controls", async () => {
    const { root, vault, runtime, options } = await fixture();
    const created = await select(vault, options);
    const legacy = path.join(root, "check-legacy");
    await mkdir(legacy);
    await installLegacy(legacy, v3Bundle());
    const before = await tree(legacy);
    const beforeRuntime = await tree(runtime);
    await expect(checkContract({ vault: legacy, locator: created.locator }, options)).rejects.toThrow();
    expect(await tree(legacy)).toEqual(before);
    expect(await tree(runtime)).toEqual(beforeRuntime);
  });
  it("returns setup-required for absent controls and does not overwrite V5 without settings", async () => {
    const { root, registry, runtime, options } = await fixture();
    const absent = path.join(root, "absent");
    await mkdir(absent);
    expect(await selectContract(migrationInput(absent), options)).toMatchObject({ state: "setup-required", admission: { status: "absent" } });
    expect(lstatSync(path.join(absent, ".oms"), { throwIfNoEntry: false })).toBeUndefined();
    const settingsOnly = path.join(root, "settings-only");
    await mkdir(path.join(settingsOnly, ".oms"), { recursive: true });
    await writeFile(path.join(settingsOnly, ".oms", "template-policy.json"), serializeContractPolicyV5(policy()));
    const before = await tree(settingsOnly);
    expect((await selectContract({ target: { vault: settingsOnly, source: "explicit" }, notePath: "Notes/saved.md", templateId: null }, options)).state).toBe("setup-required");
    expect((await selectContract(migrationInput(settingsOnly), options)).state).toBe("setup-required");
    expect(await tree(settingsOnly)).toEqual(before);
    expect(lstatSync(runtime, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(path.dirname(registry), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("snapshots malformed, ambiguous, unavailable, and absent legacy evidence without mutation", async () => {
    const { root, runtime, registry, options } = await fixture();
    for (const name of ["malformed", "ambiguous", "unavailable", "invalid-utf8", "absent"] as const) {
      const vault = path.join(root, name);
      await mkdir(path.join(vault, ".oms"), { recursive: true });
      if (name === "malformed") await writeFile(path.join(vault, ".oms", "template-transaction.json"), "{");
      if (name === "ambiguous") {
        await writeFile(path.join(vault, ".oms", "template-transaction.json"), "{}\n");
        await writeFile(path.join(vault, ".oms", "template-migration.json"), "{}\n");
      }
      const marker = path.join(vault, ".oms", "template-transaction.json");
      if (name === "invalid-utf8") await writeFile(marker, Buffer.from([0xff]));
      if (name === "unavailable") await writeFile(marker, "{}\n");
      const before = await tree(vault);
      const original = fs.promises.open;
      const spy = name === "unavailable" ? vi.spyOn(fs.promises, "open").mockImplementation(async (file, ...rest) => {
        if (path.resolve(String(file)) === marker) throw Object.assign(new Error("injected unavailable marker"), { code: "EACCES" });
        return original(file, ...rest);
      }) : undefined;
      syncBuiltinESMExports();
      const result = await (async () => {
        try { return await selectContract(migrationInput(vault), options); }
        finally { spy?.mockRestore(); syncBuiltinESMExports(); }
      })();
      expect(result).toMatchObject(name === "absent"
        ? { state: "setup-required", admission: { status: "absent" } }
        : { state: "review-required", admission: { status: name === "ambiguous" ? "legacy-ambiguous" : name === "unavailable" ? "legacy-unavailable" : "legacy-invalid" } });
      expect(await tree(vault), name).toEqual(before);
    }
    expect(lstatSync(runtime, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(path.dirname(registry), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("keeps a valid v1 B pointer byte-identical while selecting migrated A", async () => {
    const { root, registry, options } = await fixture();
    const vault = path.join(root, "pointer-a");
    const vaultB = path.join(root, "pointer-b");
    await mkdir(vault);
    await mkdir(vaultB);
    await installLegacy(vault, v3Bundle());
    const pointer = `${JSON.stringify({ version: 1, vault: vaultB, signature: createHash("sha256").update(`oms-host-vault-pointer\n1\n${vaultB}\n`).digest("hex") })}\n`;
    await mkdir(path.dirname(registry), { recursive: true });
    await writeFile(registry, pointer);
    await rm(vaultB, { recursive: true, force: true });
    const selected = await selectContract(migrationInput(vault), options);
    expect(selected.state).toBe("selected");
    if (selected.state === "selected") {
      expect(selected.migration?.stages.find(stage => stage.stage === "reservation")).toMatchObject({ state: "complete" });
      expect(selected.migration?.stages.find(stage => stage.stage === "global")).toMatchObject({ state: "pending", code: "registry-pending" });
    }
    expect(await readFile(registry, "utf8")).toBe(pointer);
    expect(lstatSync(vaultB, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("returns pending after a real coordinator fault and retries the original operation", async () => {
    const { root, runtime, options } = await fixture();
    const vault = path.join(root, "coordinator-fault");
    await mkdir(vault);
    await installLegacy(vault, v4Bundle(v4Policy(""), {}));
    const faulted = await selectContract(migrationInput(vault), { ...options, coordinatorFault: "after-intent" });
    expect(faulted.state).toBe("migration-pending");
    expect(lstatSync(path.join(runtime, "connection-coordinator", "v1", OP, "intent.json")).isFile()).toBe(true);
    expect(lstatSync(path.join(vault, ".oms", "migrations", TX, "plan.json"), { throwIfNoEntry: false })).toBeUndefined();
    const resumed = await selectContract(migrationInput(vault), options);
    expect(resumed.state).toBe("selected");
    if (resumed.state === "selected") expect(resumed.migration).toMatchObject({ operationId: OP, transactionId: TX, vaultId: ID_A });
  });
});


const SOURCE_TX = "77777777-7777-4777-8777-777777777777";
const OTHER_SOURCE_TX = "88888888-8888-4888-8888-888888888888";

describe("explicit contract source review", () => {
  it("reports registration drift and held contracts without writing", async () => {
    const { vault, options } = await fixture();
    const target = { vault, source: "explicit" as const };
    const clean = await reviewContractSources({ target });
    expect(clean.revision).toBe(1);
    // The review names the exact snapshot it read, so a caller can pair its
    // output with the same policy bytes instead of a later rewrite.
    expect(clean.policyDigest).toBe(digestBytes(await readFile(path.join(vault, ".oms", "template-policy.json"), "utf8")));
    // Review is read-only, so a deliberately read-only target is still reviewable.
    expect((await reviewContractSources({ target: { vault, source: "legacy-bridge" } })).policyDigest).toBe(clean.policyDigest);
    await expect(acknowledgeContractSource({ target: { vault, source: "legacy-bridge" }, templateId: "flower", reviewedDigest: clean.reviews[0]!.approvedDigest, transactionId: SOURCE_TX, confirmed: true }))
      .rejects.toMatchObject({ code: "SELECTION_INVALID" });
    expect(clean.reviews.map(item => [item.templateId, item.state])).toEqual([["flower", "unchanged"], ["other", "unchanged"]]);
    expect(clean.held).toEqual([]);
    // Review carries facts, never the source or note text it read.
    expect(JSON.stringify(clean)).not.toContain("must not execute");

    const before = await tree(vault);
    await writeFile(path.join(vault, "Templates", "flower.md"), `${markdown}\nuser edit\n`);
    const drifted = await reviewContractSources({ target, templateId: "flower" });
    expect(drifted.reviews).toHaveLength(1);
    expect(drifted.reviews[0]).toMatchObject({ templateId: "flower", state: "drift", path: "Templates/flower.md" });
    expect(drifted.reviews[0]?.currentDigest).not.toBe(drifted.reviews[0]?.approvedDigest);

    await rm(path.join(vault, "Templates", "other.md"));
    expect((await reviewContractSources({ target, templateId: "other" })).reviews[0]).toMatchObject({ state: "missing", currentDigest: null });
    await expect(reviewContractSources({ target, templateId: "ghost" })).rejects.toMatchObject({ code: "CONTRACT_UNKNOWN_TEMPLATE" });
    await writeFile(path.join(vault, "Templates", "other.md"), otherMarkdown);
    await writeFile(path.join(vault, "Templates", "flower.md"), markdown);
    expect(await tree(vault)).toEqual(before);
  });

  it("requires confirmation and the live digest before acknowledging reviewed bytes", async () => {
    const { vault, options } = await fixture();
    const target = { vault, source: "explicit" as const };
    await writeFile(path.join(vault, "Templates", "flower.md"), `${markdown}\nuser edit\n`);
    const review = (await reviewContractSources({ target, templateId: "flower" })).reviews[0]!;
    const before = await tree(vault);

    const unconfirmed = await acknowledgeContractSource({ target, templateId: "flower", reviewedDigest: review.currentDigest!, transactionId: SOURCE_TX, confirmed: false });
    expect(unconfirmed).toMatchObject({ state: "confirmation-required", review: { state: "drift" } });
    expect(await tree(vault)).toEqual(before);

    // A confirmation bound to bytes that are no longer live cannot publish.
    await expect(acknowledgeContractSource({ target, templateId: "flower", reviewedDigest: review.approvedDigest, transactionId: SOURCE_TX, confirmed: true }))
      .rejects.toMatchObject({ code: "SOURCE_DRIFT" });
    expect(await tree(vault)).toEqual(before);
  });

  it("advances only the reviewed source digest and records one history revision", async () => {
    const { vault, options } = await fixture();
    const target = { vault, source: "explicit" as const };
    const original = parseContractPolicyV5(await readFile(path.join(vault, ".oms", "template-policy.json"), "utf8"));
    await writeFile(path.join(vault, "Templates", "flower.md"), `${markdown}\nuser edit\n`);
    const review = (await reviewContractSources({ target, templateId: "flower" })).reviews[0]!;

    const published = await acknowledgeContractSource({ target, templateId: "flower", reviewedDigest: review.currentDigest!, transactionId: SOURCE_TX, confirmed: true });
    expect(published).toMatchObject({ state: "published", templateId: "flower", revision: 2 });
    if (published.state !== "published") throw new Error(published.state);
    expect(published.receipt.status).toBe("complete");
    expect(published.receipt.verified.map(item => item.path)).toEqual([".oms/template-policy.json", ".oms/history/contracts/2.json"]);

    const next = parseContractPolicyV5(await readFile(path.join(vault, ".oms", "template-policy.json"), "utf8"));
    const before = original.templates.flower;
    const after = next.templates.flower;
    if (before.status !== "active" || after.status !== "active") throw new Error("fixture");
    expect(next.revision).toBe(2);
    expect(after.source.rawDigest).toBe(review.currentDigest);
    // Only the SHA moved: rules, identity, path, and every other registration stay.
    expect(after.fields).toEqual(before.fields);
    expect(after.source.identity).toBe(before.source.identity);
    expect(after.source.path).toBe(before.source.path);
    expect(next.templates.other).toEqual(original.templates.other);
    expect(next.properties).toEqual(original.properties);
    const history = JSON.parse(await readFile(path.join(vault, ".oms", "history", "contracts", "2.json"), "utf8") as string) as Record<string, unknown>;
    expect(history).toMatchObject({ kind: "source-review", transactionId: SOURCE_TX, revision: 2 });
    expect((await reviewContractSources({ target, templateId: "flower" })).reviews[0]?.state).toBe("unchanged");
    // A selection now binds the acknowledged bytes without further review.
    expect((await select(vault, options)).selected.binding.sourceDigest).toBe(review.currentDigest);
  });

  it("relocates a registration only when the original is genuinely missing", async () => {
    const { vault, options } = await fixture();
    const target = { vault, source: "explicit" as const };
    const before = await tree(vault);
    await writeFile(path.join(vault, "Templates", "copy.md"), markdown);

    await expect(relinkContractSource({ target, templateId: "flower", candidatePath: "Templates/copy.md", transactionId: SOURCE_TX, confirmed: true }))
      .rejects.toMatchObject({ code: "SOURCE_NOT_MISSING" });

    await rm(path.join(vault, "Templates", "flower.md"));
    const unconfirmed = await relinkContractSource({ target, templateId: "flower", candidatePath: "Templates/copy.md", transactionId: SOURCE_TX, confirmed: false });
    expect(unconfirmed).toMatchObject({ state: "confirmation-required", review: { state: "missing" } });

    const published = await relinkContractSource({ target, templateId: "flower", candidatePath: "Templates/copy.md", transactionId: OTHER_SOURCE_TX, confirmed: true });
    expect(published).toMatchObject({ state: "published", revision: 2 });
    const next = parseContractPolicyV5(await readFile(path.join(vault, ".oms", "template-policy.json"), "utf8"));
    const entry = next.templates.flower;
    if (entry.status !== "active") throw new Error("fixture");
    expect(entry.source.path).toBe("Templates/copy.md");
    expect(entry.source.rawDigest).toBe(digestBytes(markdown));
    expect(Object.keys(before)).not.toContain(path.join("Templates", "copy.md"));
  });
});


const PUBLISH_TX = "99999999-9999-4999-8999-999999999999";

describe("explicit contract publication", () => {
  it("previews a revision, publishes it, and refuses a stale or malformed document", async () => {
    const { vault, options } = await fixture();
    const target = { vault, source: "explicit" as const };
    const current = parseContractPolicyV5(await readFile(path.join(vault, ".oms", "template-policy.json"), "utf8"));
    const flower = current.templates.flower;
    if (flower.status !== "active") throw new Error("fixture");
    const next: ContractPolicyV5 = {
      ...current,
      revision: 2,
      properties: { ...current.properties, note: { type: "text", intent: "Free note." } },
      templates: { ...current.templates, flower: { ...flower, fields: { ...flower.fields, note: {} } } },
    };

    const preview = await publishContract({ target, policy: next, transactionId: PUBLISH_TX, confirmed: false });
    expect(preview).toMatchObject({
      state: "confirmation-required",
      plan: { revision: 2, addedTemplates: [], removedTemplates: [], changedTemplates: ["flower"], propertiesChanged: true, commonChanged: false },
    });
    const before = await tree(vault);
    expect(await tree(vault)).toEqual(before);

    const published = await publishContract({ target, policy: next, transactionId: PUBLISH_TX, confirmed: true });
    expect(published).toMatchObject({ state: "published", revision: 2 });
    if (published.state !== "published") throw new Error(published.state);
    expect(published.receipt.status).toBe("complete");
    expect(published.receipt.verified.map(item => item.path)).toEqual([".oms/template-policy.json", ".oms/history/contracts/2.json"]);
    expect(JSON.parse(await readFile(path.join(vault, ".oms", "history", "contracts", "2.json"), "utf8") as string)).toMatchObject({ kind: "publication", transactionId: PUBLISH_TX, revision: 2 });
    // The published document is exactly the caller's contract, canonicalized.
    expect(parseContractPolicyV5(await readFile(path.join(vault, ".oms", "template-policy.json"), "utf8"))).toEqual(next);

    // A second publication of the same revision is refused: the revision must advance.
    await expect(publishContract({ target, policy: next, transactionId: "aaaaaaaa-9999-4999-8999-999999999999", confirmed: true }))
      .rejects.toMatchObject({ code: "CONTRACT_POLICY_INVALID" });
    await expect(publishContract({ target, policy: { version: 5, revision: 3 }, transactionId: "bbbbbbbb-9999-4999-8999-999999999999", confirmed: true }))
      .rejects.toBeInstanceOf(Error);
  });

  it("refuses a document whose declared source bytes are not the live ones", async () => {
    const { vault, options } = await fixture();
    const target = { vault, source: "explicit" as const };
    const current = parseContractPolicyV5(await readFile(path.join(vault, ".oms", "template-policy.json"), "utf8"));
    const flower = current.templates.flower;
    if (flower.status !== "active") throw new Error("fixture");
    const forged: ContractPolicyV5 = {
      ...current,
      revision: 2,
      templates: { ...current.templates, flower: { ...flower, source: { ...flower.source, rawDigest: digestBytes("not the live source") } } },
    };
    const before = await tree(vault);
    await expect(publishContract({ target, policy: forged, transactionId: PUBLISH_TX, confirmed: true })).rejects.toThrow(/Source changed before publication/);
    expect(await tree(vault)).toEqual(before);
  });

  it("refuses to publish over a historical policy or without portable settings", async () => {
    const { root, options } = await fixture();
    const legacy = path.join(root, "legacy-publish");
    await mkdir(path.join(legacy, ".oms"), { recursive: true });
    await writeFile(path.join(legacy, ".oms", "settings.json"), serializeVaultSettings(settings(ID_B)));
    await writeFile(path.join(legacy, ".oms", "template-policy.json"), JSON.stringify({ version: 4, properties: {}, templates: {} }));
    const before = await tree(legacy);
    await expect(publishContract({ target: { vault: legacy, source: "explicit" }, policy: policy(), transactionId: PUBLISH_TX, confirmed: true }))
      .rejects.toMatchObject({ code: "SELECTION_UNSAFE" });
    expect(await tree(legacy)).toEqual(before);

    const bare = path.join(root, "bare-publish");
    await mkdir(bare, { recursive: true });
    await expect(publishContract({ target: { vault: bare, source: "explicit" }, policy: policy(), transactionId: PUBLISH_TX, confirmed: true }))
      .rejects.toMatchObject({ code: "VAULT_SETTINGS_MISSING" });
    expect(lstatSync(path.join(bare, ".oms"), { throwIfNoEntry: false })).toBeUndefined();
  });
});


describe("exact control bytes and unreadable controls", () => {
  it("publishes over a valid non-canonical policy instead of conflicting with its own bytes", async () => {
    const { vault, options } = await fixture();
    const target = { vault, source: "explicit" as const };
    const file = path.join(vault, ".oms", "template-policy.json");
    const current = parseContractPolicyV5(await readFile(file, "utf8"));
    // A hand-edited but valid policy: different whitespace, same meaning.
    await writeFile(file, `${JSON.stringify(current, null, 4)}\n\n`);

    const published = await publishContract({ target, policy: { ...current, revision: current.revision + 1 }, transactionId: PUBLISH_TX, confirmed: true });

    expect(published).toMatchObject({ state: "published", revision: current.revision + 1 });
    // The published bytes are canonical; the preimage that was swapped was not.
    expect(await readFile(file, "utf8")).toBe(serializeContractPolicyV5(parseContractPolicyV5(await readFile(file, "utf8"))));
  });

  it("acknowledges a reviewed source over a non-canonical policy", async () => {
    const { vault, options } = await fixture();
    const target = { vault, source: "explicit" as const };
    const file = path.join(vault, ".oms", "template-policy.json");
    await writeFile(file, `${JSON.stringify(parseContractPolicyV5(await readFile(file, "utf8")), null, 4)}\n`);
    await writeFile(path.join(vault, "Templates", "flower.md"), `${markdown}\nuser edit\n`);
    const review = (await reviewContractSources({ target, templateId: "flower" })).reviews[0]!;

    const published = await acknowledgeContractSource({ target, templateId: "flower", reviewedDigest: review.currentDigest!, transactionId: SOURCE_TX, confirmed: true });

    expect(published).toMatchObject({ state: "published", revision: 2 });
  });

  it("reports an unreadable policy as a typed diagnosis and refuses to publish over it", async () => {
    const { vault, options } = await fixture();
    const target = { vault, source: "explicit" as const };
    const file = path.join(vault, ".oms", "template-policy.json");
    const before = await readFile(file);
    await chmod(file, 0o000);
    try {
      const diagnosis = await diagnoseContract({ target });
      expect(diagnosis.status).toBe("needs-repair");
      expect(diagnosis.diagnostics.map(item => item.code)).toContain("CONTRACT_POLICY_UNREADABLE");
      // An unreadable contract is never replaced by a fresh publication.
      await expect(publishContract({ target, policy: policy(), transactionId: PUBLISH_TX, confirmed: true }))
        .rejects.toMatchObject({ code: "SELECTION_UNSAFE" });
      const held = await selectContract({ target, notePath: "Notes/saved.md", templateId: null }, options);
      expect(held.state).toBe("review-required");
    } finally {
      await chmod(file, 0o644);
    }
    expect(await readFile(file)).toEqual(before);
  });
});
