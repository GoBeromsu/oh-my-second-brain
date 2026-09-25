import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { serializeVaultSettings } from "../kernel/vault/settings.js";
import { runModelCommand } from "./model-command.js";

const roots: string[] = [];
const VAULT_ID = "11111111-2222-4333-8444-555555555555";
const originalCwd = process.cwd();
const originalCache = process.env.XDG_CACHE_HOME;

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCache;
  process.exitCode = 0;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ readonly root: string; readonly vault: string; readonly descriptor: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "oms-model-command-"));
  roots.push(root);
  const vault = path.join(root, "vault");
  const source = path.join(root, "embed.gguf");
  const descriptor = path.join(root, "descriptor.json");
  const bytes = Buffer.from("synthetic model bytes");
  await mkdir(path.join(vault, ".oms"), { recursive: true });
  await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: VAULT_ID }));
  await writeFile(source, bytes);
  await writeFile(descriptor, JSON.stringify({
    schemaVersion: 1,
    embed: {
      provider: "gguf",
      model: "synthetic.gguf",
      revision: "v1.0.0",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      promptScheme: "embeddinggemma-v1",
      path: source,
      dimensions: 8,
      contextLength: 32,
      mrlDim: 0,
      normalization: "l2",
    },
  }));
  process.env.XDG_CACHE_HOME = path.join(root, "cache");
  return { root, vault, descriptor };
}

async function invoke(argv: readonly string[]): Promise<Record<string, unknown>> {
  const writes: string[] = [];
  vi.spyOn(console, "log").mockImplementation(value => writes.push(String(value)));
  await runModelCommand(argv);
  return JSON.parse(writes.at(-1)!) as Record<string, unknown>;
}

describe("model command", () => {
  it("persists only an acquired, verified selection after matching dry-run approval and reads it back", async () => {
    const { vault, descriptor } = await fixture();
    const installProposal = await invoke(["install", "--descriptor", descriptor, "--dry-run"]);
    expect(process.exitCode).toBe(0);
    vi.restoreAllMocks();
    const installed = await invoke(["install", "--descriptor", descriptor, "--yes", "--approved-digest", String(installProposal.approvalDigest)]);
    expect(installed).toMatchObject({ status: "installed", verified: true });

    vi.restoreAllMocks();
    const selectionProposal = await invoke(["select", "--descriptor", descriptor, "--vault", vault, "--dry-run"]);
    vi.restoreAllMocks();
    const selected = await invoke(["select", "--descriptor", descriptor, "--vault", vault, "--yes", "--approved-digest", String(selectionProposal.approvalDigest)]);
    expect(selected).toMatchObject({ status: "written", verified: true });
    expect(JSON.parse(await readFile(path.join(vault, ".oms", "settings.json"), "utf8"))).toEqual({ version: 1, vaultId: VAULT_ID, embedding: { model: "synthetic.gguf" } });
    expect(await readdir(path.join(vault, ".oms"))).toEqual(["settings.json"]);

    vi.restoreAllMocks();
    const status = await invoke(["status", "--vault", vault]);
    expect(status).toMatchObject({ status: "ok", embeddingModel: "synthetic.gguf" });
  });

  it("keeps status read-only and does not create a vault engine store or model config", async () => {
    const { vault } = await fixture();
    const before = await readFile(path.join(vault, ".oms", "settings.json"), "utf8");
    const status = await invoke(["status", "--vault", vault]);
    expect(status).toMatchObject({ status: "ok", embeddingModel: null });
    expect(existsSync(path.join(vault, ".oms", "engine-store.sqlite"))).toBe(false);
    expect(await readdir(path.join(vault, ".oms"))).toEqual(["settings.json"]);
    expect(await readFile(path.join(vault, ".oms", "settings.json"), "utf8")).toBe(before);
  });

  it("rejects unknown and retired leaves and flags", async () => {
    await fixture();
    for (const argv of [["download"], ["install", "--models-default"], ["status", "--force"]] as const) {
      vi.restoreAllMocks();
      const result = await invoke(argv);
      expect(process.exitCode).toBe(1);
      expect(result.status).toBe("rejected");
    }
  });

  it("refuses selection in a vault that oms setup has not issued settings for", async () => {
    const { root, descriptor } = await fixture();
    const bare = path.join(root, "bare");
    await mkdir(bare);
    const installProposal = await invoke(["install", "--descriptor", descriptor, "--dry-run"]);
    vi.restoreAllMocks();
    await invoke(["install", "--descriptor", descriptor, "--yes", "--approved-digest", String(installProposal.approvalDigest)]);
    vi.restoreAllMocks();
    const result = await invoke(["select", "--descriptor", descriptor, "--vault", bare, "--dry-run"]);
    expect(process.exitCode).toBe(1);
    expect(result).toMatchObject({ status: "rejected", diagnostics: [{ code: "VAULT_SETTINGS_MISSING" }] });
    expect(await readdir(bare)).toEqual([]);
  });

  it("reports an explicit operation-scoped waiver without inventing persisted state", async () => {
    const { vault } = await fixture();
    const result = await invoke(["waive", "--vault", vault, "--yes"]);
    expect(result).toMatchObject({ status: "waived", scope: "this-operation", persisted: false, embeddingModelPreserved: null });
    expect(await readdir(path.join(vault, ".oms"))).toEqual(["settings.json"]);
  });
});
