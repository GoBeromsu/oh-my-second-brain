import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { v4Bundle } from "../../test/fixtures/legacy-publication-builders.js";
import { serializeContractPolicyV5, type ContractPolicyV5 } from "../kernel/templates/contract-v5.js";
import { serializeVaultSettings } from "../kernel/templates/vault-settings.js";

/**
 * Fresh setup end to end, against the built CLI.
 *
 * Dry-run prints a paired approval token and outer digest. Apply writes native
 * settings and the connection only after both exact values and --yes. It does
 * not invent policy, taxonomy, types, or Markdown.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");
const roots: string[] = [];
const VAULT_ID = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function vault(files: Readonly<Record<string, string | Uint8Array>> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "oms-setup-e2e-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.join(root, relative, ".."), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  return root;
}

function runSetupCli(args: readonly string[], env: Readonly<Record<string, string>> = {}) {
  if (!existsSync(distCli)) throw new Error("dist/cli/oms.js is missing; run npm run build before setup CLI tests.");
  return spawnSync(process.execPath, [distCli, "setup", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, OMS_NO_UPDATE_NOTICE: "1", HOME: roots[0] ?? tmpdir(), USERPROFILE: roots[0] ?? tmpdir(), ...env },
  });
}

function parse(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function tree(root: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  let entries;
  try { entries = await readdir(path.join(root, prefix), { withFileTypes: true }); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await tree(root, relative));
    else result[relative] = await readFile(path.join(root, relative), "utf8");
  }
  return result;
}

function policy(): string {
  const value: ContractPolicyV5 = {
    version: 5,
    revision: 1,
    properties: { title: { type: "text" } },
    common: { status: "active", fields: { title: { required: true } } },
    templates: {},
  };
  return serializeContractPolicyV5(value);
}

function proposalOf(root: string, extra: readonly string[] = []): Record<string, unknown> {
  const dryRun = runSetupCli(["--vault", root, "--dry-run", ...extra]);
  expect(dryRun.status, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0);
  return parse(dryRun.stdout);
}

function applyArgs(root: string, proposal: Record<string, unknown>, extra: readonly string[] = []): string[] {
  return ["--vault", root, "--yes", "--approval-token", String(proposal.approvalToken), "--approved-digest", String(proposal.approvalDigest), ...extra];
}

describe("oms setup end to end", () => {
  it("proposes native settings without policy, types, or writes", async () => {
    const root = await vault({ "notes/existing.md": "Existing note.\n" });
    const before = await tree(root);
    const proposal = proposalOf(root);

    expect(proposal.status).toBe("proposed");
    expect(proposal.state).toBe("contract-setup-required");
    expect(proposal.document).toEqual(expect.objectContaining({ state: "contract-setup-required", nextStep: "configure-contract" }));
    expect(proposal.document).not.toHaveProperty("policy");
    expect(proposal.approvalDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(proposal.connectionDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(typeof proposal.approvalToken).toBe("string");
    expect(proposal).not.toHaveProperty("policyProposal");
    expect(await tree(root)).toEqual(before);
  });

  it("reports folder hints without adopting a template or reading its syntax", async () => {
    const source = "---\ntitle: <%* throw new Error(\"executed\") %>\n---\nbody\n";
    const root = await vault({
      "Templates/note.md": source,
      ".obsidian/templates.json": JSON.stringify({ folder: "Templates" }),
    });
    const proposal = proposalOf(root);
    const document = proposal.document as { readonly templateFolderHints: readonly { readonly path: string }[] };
    expect(document.templateFolderHints.map(hint => hint.path)).toContain("Templates");
    expect(proposal).not.toHaveProperty("policy");
    expect(await readFile(path.join(root, "Templates", "note.md"), "utf8")).toBe(source);
  });

  it("refuses a forged digest and a missing token without creating a root", async () => {
    const missing = path.join(tmpdir(), `oms-setup-missing-${randomUUID()}`);
    const absent = runSetupCli(["--vault", missing, "--dry-run"]);
    expect(absent.status).toBe(1);
    expect(existsSync(missing)).toBe(false);

    const root = await vault();
    const before = await tree(root);
    const forged = runSetupCli(["--vault", root, "--yes", "--approval-token", "e30", "--approved-digest", `sha256:${"0".repeat(64)}`]);
    const missingToken = runSetupCli(["--vault", root, "--yes", "--approved-digest", `sha256:${"a".repeat(64)}`]);
    expect(forged.status).toBe(1);
    expect(missingToken.status).toBe(1);
    expect(await tree(root)).toEqual(before);
    expect(existsSync(path.join(root, ".oms"))).toBe(false);
  });

  it("publishes settings and the bridge without injected types or a V4 policy", async () => {
    const root = await vault({ "notes/existing.md": "Existing note.\n" });
    const proposal = proposalOf(root);
    const applied = runSetupCli(applyArgs(root, proposal));

    expect(applied.status, `${applied.stdout}\n${applied.stderr}`).toBe(0);
    expect(existsSync(path.join(root, ".oms", "template-policy.json"))).toBe(false);
    expect(existsSync(path.join(root, ".oms", "taxonomy.json"))).toBe(false);
    expect(existsSync(path.join(root, ".obsidian", "types.json"))).toBe(false);
    expect(JSON.parse(await readFile(path.join(root, ".oms", "settings.json"), "utf8"))).toMatchObject({ version: 1, templateRoots: [] });
    expect(await readFile(path.join(root, "notes", "existing.md"), "utf8")).toBe("Existing note.\n");

    const bridgeRoot = await vault();
    const linked = path.join(bridgeRoot, "repo");
    await mkdir(linked, { recursive: true });
    const bridge = spawnSync(process.execPath, [distCli, "bridge", "add", "--vault", root, "--folder", "notes"], {
      cwd: linked,
      encoding: "utf8",
      env: { ...process.env, OMS_NO_UPDATE_NOTICE: "1" },
    });
    expect(bridge.status, `${bridge.stdout}\n${bridge.stderr}`).toBe(0);
    expect(existsSync(path.join(linked, ".oms", "linked", "notes"))).toBe(true);
  });

  it("keeps a manual V5 policy and refuses a historical marker without a legacy bypass", async () => {
    const manual = await vault({ ".oms/template-policy.json": policy(), "notes/kept.md": "Kept.\n" });
    const before = await tree(manual);
    const proposal = proposalOf(manual);
    expect(proposal.state).toBe("contract-configured");
    expect((proposal.document as { readonly policy: unknown }).policy).toMatchObject({ version: 5, revision: 1 });
    expect(runSetupCli(applyArgs(manual, proposal)).status).toBe(0);
    expect(await readFile(path.join(manual, ".oms", "template-policy.json"), "utf8")).toBe(before[".oms/template-policy.json"]);
    expect(await readFile(path.join(manual, "notes", "kept.md"), "utf8")).toBe("Kept.\n");

    const historical = await vault();
    const bundle = v4Bundle();
    await mkdir(path.join(historical, path.dirname(bundle.markerPath)), { recursive: true });
    await mkdir(path.join(historical, path.dirname(bundle.planPath)), { recursive: true });
    await writeFile(path.join(historical, bundle.markerPath), bundle.markerBytes);
    await writeFile(path.join(historical, bundle.planPath), bundle.planBytes);
    for (const [relative, bytes] of Object.entries(bundle.observed)) {
      await mkdir(path.join(historical, path.dirname(relative)), { recursive: true });
      await writeFile(path.join(historical, relative), bytes);
    }
    const heldBefore = await tree(historical);
    const held = runSetupCli(["--vault", historical, "--dry-run"]);
    expect(held.status).toBe(1);
    expect(parse(held.stdout).state).toBe("held-legacy");
    expect(await tree(historical)).toEqual(heldBefore);
  });

  it("refuses a changed token, source, digest, or model choice before effects", async () => {
    const root = await vault({ "notes/existing.md": "Existing note.\n" });
    const before = await tree(root);
    const proposal = proposalOf(root);
    const token = JSON.parse(Buffer.from(String(proposal.approvalToken), "base64url").toString("utf8")) as Record<string, unknown>;
    const changed = Buffer.from(JSON.stringify({ ...token, modelsNoDefault: true }), "utf8").toString("base64url");
    const mismatched = runSetupCli(["--vault", root, "--yes", "--approval-token", changed, "--approved-digest", String(proposal.approvalDigest)]);
    const waived = runSetupCli([...applyArgs(root, proposal), "--models-no-default"]);
    const inferred = runSetupCli(["--yes", "--approval-token", String(proposal.approvalToken), "--approved-digest", String(proposal.approvalDigest)], {});
    expect(mismatched.status).toBe(1);
    expect(waived.status).toBe(1);
    expect(inferred.status).toBe(1);
    expect(await tree(root)).toEqual(before);
  });

  it("refuses a rehashed model config digest and a stale current digest before any effect", async () => {
    const root = await vault({ ".oms/settings.json": serializeVaultSettings({ version: 1, vaultId: VAULT_ID, templateRoots: [] }) });
    const external = await mkdtemp(path.join(tmpdir(), "oms-setup-token-"));
    roots.push(external);
    const artifact = path.join(external, "weights.gguf");
    const bytes = Buffer.from("synthetic-token-model");
    await writeFile(artifact, bytes);
    const descriptor = path.join(external, "descriptor.json");
    await writeFile(descriptor, JSON.stringify({
      schemaVersion: 1,
      embed: {
        provider: "gguf", model: "synthetic.gguf", revision: "v1",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        promptScheme: "embeddinggemma-v1", path: artifact,
        dimensions: 8, contextLength: 16, mrlDim: 0, normalization: "l2",
      },
    }));
    const proposal = proposalOf(root, ["--models-descriptor", descriptor]);
    const decoded = JSON.parse(Buffer.from(String(proposal.approvalToken), "base64url").toString("utf8")) as {
      model: { configDigest: string; expectedCurrent: string };
    };
    const before = await tree(root);
    const rehashed = {
      ...decoded,
      model: { ...decoded.model, configDigest: `sha256:${"b".repeat(64)}` },
    };
    const stale = {
      ...decoded,
      model: { ...decoded.model, expectedCurrent: `sha256:${"c".repeat(64)}` },
    };
    for (const token of [rehashed, stale]) {
      const canonical = canonicalToken(token);
      const digest = createHash("sha256").update(`oms.setup.v5.approval.v1\0${canonical}`).digest("hex");
      const applied = runSetupCli([
        "--vault", root, "--yes", "--models-descriptor", descriptor,
        "--approval-token", Buffer.from(canonical, "utf8").toString("base64url"),
        "--approved-digest", `sha256:${digest}`,
      ]);
      expect(applied.status).toBe(1);
      expect(applied.stdout).not.toContain("\"status\": \"completed\"");
    }
    expect(await tree(root)).toEqual(before);
    expect(existsSync(path.join(root, ".oms", "models.json"))).toBe(false);
  });

  it("repeats the same token as an exact native receipt and acquires no model without a request", async () => {
    const root = await vault();
    const proposal = proposalOf(root);
    expect(runSetupCli(applyArgs(root, proposal)).status).toBe(0);
    const first = await tree(root);
    const repeated = runSetupCli(applyArgs(root, proposal));
    expect(repeated.status, `${repeated.stdout}\n${repeated.stderr}`).toBe(0);
    expect(await tree(root)).toEqual(first);
    expect(existsSync(path.join(root, ".oms", "models.json"))).toBe(false);
  });

  it("uses an external local model artifact and refuses different existing model bytes before download", async () => {
    const root = await vault({ ".oms/settings.json": serializeVaultSettings({ version: 1, vaultId: VAULT_ID, templateRoots: [] }) });
    const external = await mkdtemp(path.join(tmpdir(), "oms-setup-model-"));
    roots.push(external);
    const artifact = path.join(external, "weights.gguf");
    const bytes = Buffer.from("synthetic-local-model");
    await writeFile(artifact, bytes);
    const manifest = {
      schemaVersion: 1,
      embed: {
        provider: "gguf",
        model: "synthetic.gguf",
        revision: "v1",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        promptScheme: "embeddinggemma-v1",
        path: artifact,
        dimensions: 8,
        contextLength: 16,
        mrlDim: 0,
        normalization: "l2",
      },
    };
    const descriptor = path.join(external, "descriptor.json");
    await writeFile(descriptor, JSON.stringify(manifest));
    const proposal = proposalOf(root, ["--models-descriptor", descriptor]);
    expect(proposal.model).toMatchObject({ expectedCurrent: "sha256:absent" });
    const applied = runSetupCli(applyArgs(root, proposal, ["--models-descriptor", descriptor]), {
      XDG_CACHE_HOME: path.join(external, "cache"),
    });
    expect(applied.status, `${applied.stdout}\n${applied.stderr}`).toBe(0);
    expect(existsSync(path.join(root, ".oms", "models.json"))).toBe(true);

    const conflictRoot = await vault({
      ".oms/settings.json": serializeVaultSettings({ version: 1, vaultId: VAULT_ID, templateRoots: [] }),
      ".oms/models.json": "{\"schemaVersion\":1,\"embed\":{\"provider\":\"gguf\",\"model\":\"other.gguf\",\"revision\":\"v9\",\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"promptScheme\":\"embeddinggemma-v1\"}}\n",
    });
    await writeFile(path.join(external, "conflict-descriptor.json"), JSON.stringify(manifest));
    const before = await tree(conflictRoot);
    const conflict = runSetupCli(["--vault", conflictRoot, "--dry-run", "--models-descriptor", path.join(external, "conflict-descriptor.json")]);
    expect(conflict.status).toBe(1);
    expect(await tree(conflictRoot)).toEqual(before);
  });
});

function canonicalToken(value: unknown): string {
  const normalized = normalize(value);
  return serialize(normalized);
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalize);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) result[key] = normalize((value as Record<string, unknown>)[key]);
  return result;
}

function serialize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).map(key => `${JSON.stringify(key)}:${serialize(record[key])}`).join(",")}}`;
}
