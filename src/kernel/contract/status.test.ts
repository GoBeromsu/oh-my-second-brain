import { cp, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectDrift } from "./drift.js";
import { extractTemplate } from "./extract.js";
import { writePublicManifest } from "./public.js";
import { contractStatus } from "./status.js";
import { sealLayer } from "./store.js";
import type { PublicManifest } from "./types.js";
import { ensureVaultId } from "./vault-id.js";

const roots: string[] = [];
const previousRoot = process.env["OMS_CONTRACT_STORE_ROOT"];
const COMMON = "00000000-0000-4000-8000-0000000000c0";
const TEMPLATE = "00000000-0000-4000-8000-0000000000d0";
const SOURCE = "Templates/Meeting.md";
let base: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-contract-status-")));
  roots.push(base);
  process.env["OMS_CONTRACT_STORE_ROOT"] = join(base, "store");
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env["OMS_CONTRACT_STORE_ROOT"];
  else process.env["OMS_CONTRACT_STORE_ROOT"] = previousRoot;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), content);
}

/** Seals a common layer and one template, the way the CLI will. */
async function sealedVault(): Promise<{ readonly vault: string; readonly manifest: PublicManifest }> {
  const vault = join(base, "vault");
  await put(vault, SOURCE, "---\nstatus: open\n---\n# Agenda\n");
  const extraction = await extractTemplate(vault, SOURCE);
  if (!extraction.ok) throw new Error("extraction failed");
  const id = await ensureVaultId(vault);
  if (id.state !== "ok") throw new Error("vault id failed");
  const manifest: PublicManifest = {
    version: 1,
    common: { sealId: COMMON, fields: [] },
    templates: [{ id: SOURCE, name: "Meeting", applyFolder: null, fields: [], requiredHeadings: ["Agenda"], sourceHash: extraction.extraction.sourceHash, sealId: TEMPLATE }],
  };
  const common = { sealId: COMMON, fields: [], requiredHeadings: [], applyFolder: null, sourcePath: null, sourceHash: null, answers: {} };
  expect(await sealLayer(id.id, common, vault)).toEqual({ ok: true });
  expect(await sealLayer(id.id, { ...common, sealId: TEMPLATE, requiredHeadings: ["Agenda"], sourcePath: SOURCE, sourceHash: extraction.extraction.sourceHash }, vault)).toEqual({ ok: true });
  expect(await writePublicManifest(vault, manifest)).toEqual({ ok: true });
  return { vault, manifest };
}

describe("contractStatus", () => {
  it("reports no-contract for a plain vault and creates nothing", async () => {
    const vault = join(base, "plain");
    await mkdir(vault);
    expect(await contractStatus(vault)).toEqual({ vault: "no-contract", location: "unknown", templates: [], common: "none", legacyPolicyPresent: false });
    expect(await readdir(vault)).toEqual([]);
    expect(await readdir(base)).toEqual(["plain"]);
  });

  it("flags a legacy policy file", async () => {
    const vault = join(base, "legacy");
    await put(vault, ".oms/template-policy.json", "{}");
    expect((await contractStatus(vault)).legacyPolicyPresent).toBe(true);
  });

  it("reports ok, active and the same location for a sealed vault", async () => {
    const { vault } = await sealedVault();
    expect(await contractStatus(vault)).toEqual({
      vault: "ok",
      location: "same",
      templates: [{ id: SOURCE, name: "Meeting", state: "active" }],
      common: "active",
      legacyPolicyPresent: false,
    });
  });

  it("reports drift and missing sources", async () => {
    const { vault, manifest } = await sealedVault();
    await put(vault, SOURCE, "---\nstatus: closed\n---\n# Agenda\n");
    expect((await contractStatus(vault)).templates[0]?.state).toBe("drift");
    expect((await detectDrift(vault, manifest)).get(SOURCE)).toBe("drift");
    await rm(join(vault, SOURCE));
    const status = await contractStatus(vault);
    expect(status.templates[0]?.state).toBe("missing");
    expect(status.vault).toBe("ok");
  });

  it("reports unreadable for a corrupt layer, a missing store or a bad vault id", async () => {
    const { vault } = await sealedVault();
    const storeRoot = join(base, "store");
    const [vaultId] = await readdir(storeRoot);
    await writeFile(join(storeRoot, vaultId!, "layers", `${TEMPLATE}.json`), "{");
    let status = await contractStatus(vault);
    expect(status.vault).toBe("unreadable");
    expect(status.templates[0]?.state).toBe("unreadable");
    expect(status.common).toBe("active");

    await rm(storeRoot, { recursive: true });
    status = await contractStatus(vault);
    expect(status).toMatchObject({ vault: "unreadable", common: "unreadable", location: "unknown" });

    await writeFile(join(vault, ".oms/vault-id"), "bad");
    status = await contractStatus(vault);
    expect(status).toMatchObject({ vault: "unreadable", templates: [{ id: SOURCE, name: "Meeting", state: "unreadable" }] });
    expect(await readdir(base)).toEqual(["vault"]);
  });

  it("reports unreadable for an invalid manifest", async () => {
    const { vault } = await sealedVault();
    await writeFile(join(vault, ".oms/contract-public.json"), "{");
    expect((await contractStatus(vault)).vault).toBe("unreadable");
  });

  it("tells a moved vault from a suspected clone", async () => {
    const { vault } = await sealedVault();
    const clone = join(base, "clone");
    await cp(vault, clone, { recursive: true });
    expect((await contractStatus(clone)).location).toBe("clone-suspect");
    const moved = join(base, "moved");
    await rename(vault, moved);
    expect((await contractStatus(moved)).location).toBe("moved");
  });
});
