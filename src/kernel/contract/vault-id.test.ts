import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addSharedCopy, buildTruthTableRow, TRUTH_TABLE_ROWS, type TruthTableFixture } from "../../../test/fixtures/contract-truth-table.js";
import { SETTINGS_PATH, VAULT_ID_PATTERN } from "../vault/settings.js";
import type { ContractView } from "./types.js";
import { ensureVaultId, resolveSealState, type SealRow } from "./vault-id.js";

const fixtures: TruthTableFixture[] = [];
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function row(name: SealRow): Promise<TruthTableFixture> {
  const fixture = await buildTruthTableRow(name);
  fixtures.push(fixture);
  return fixture;
}

type ExpectedView = "open" | "sealed" | "broken" | "tampered";

const EXPECTED_VIEW: Readonly<Record<SealRow, ExpectedView>> = {
  "never-sealed": "open",
  "synced-second-machine": "open",
  "store-without-index": "sealed",
  "vault-moved": "sealed",
  "sealed": "sealed",
  "index-without-store": "broken",
  "settings-missing": "broken",
  "vault-id-tampered": "tampered",
  "index-corrupt": "sealed",
};

function viewKind(view: ContractView): ExpectedView {
  return view.state === "unreadable" ? view.reason : view.state;
}

describe("resolveSealState truth table", () => {
  it("covers exactly nine rows", () => {
    expect(new Set(TRUTH_TABLE_ROWS).size).toBe(9);
  });

  for (const name of TRUTH_TABLE_ROWS) {
    it(`resolves ${name}`, async () => {
      const fixture = await row(name);
      const state = await resolveSealState(fixture.vault, fixture.root);
      expect(state.row).toBe(name);
      expect(viewKind(state.view)).toBe(EXPECTED_VIEW[name]);
      expect(state.shared).toBe(false);
      expect(state.settingsInvalid).toBe(false);
      if (name === "never-sealed" || name === "settings-missing") expect(state.vaultId).toBeNull();
      else if (name !== "vault-id-tampered") expect(state.vaultId).toBe(fixture.vaultId);
    });
  }

  it("is read-only: resolving creates no store root or settings", async () => {
    const fixture = await row("never-sealed");
    await resolveSealState(fixture.vault, fixture.root);
    await expect(readFile(join(fixture.vault, SETTINGS_PATH))).rejects.toThrow();
    await expect(readFile(join(fixture.root, "index.json"))).rejects.toThrow();
  });

  it("reports a copied vault as shared", async () => {
    const fixture = await row("sealed");
    await addSharedCopy(fixture);
    const state = await resolveSealState(fixture.vault, fixture.root);
    expect(state.row).toBe("sealed");
    expect(state.shared).toBe(true);
  });

  it("marks invalid settings without throwing", async () => {
    const fixture = await row("never-sealed");
    await mkdir(join(fixture.vault, ".oms"), { recursive: true });
    await writeFile(join(fixture.vault, SETTINGS_PATH), "{\"version\":1,\"vaultId\":\"not-a-uuid\"}");
    const state = await resolveSealState(fixture.vault, fixture.root);
    expect(state.settingsInvalid).toBe(true);
    expect(state.row).toBe("never-sealed");
    expect(state.view.state).toBe("open");
  });
});

describe("a missing vault id is broken, a different one is tampered", () => {
  it("treats invalid settings on a sealed vault as settings-missing, not tampered", async () => {
    const fixture = await row("sealed");
    await writeFile(join(fixture.vault, SETTINGS_PATH), "{\"version\":1,\"vaultId\":\"not-a-uuid\"}");
    const state = await resolveSealState(fixture.vault, fixture.root);
    expect(state.settingsInvalid).toBe(true);
    expect(state.row).toBe("settings-missing");
    expect(state.view).toEqual({ state: "unreadable", reason: "broken" });
  });

  it("treats a deleted settings file on a sealed vault as broken", async () => {
    const fixture = await row("settings-missing");
    const state = await resolveSealState(fixture.vault, fixture.root);
    expect(state.view).toEqual({ state: "unreadable", reason: "broken" });
    expect(state.vaultId).toBeNull();
  });

  it("reports tampered only when a present settings id differs from the index", async () => {
    const fixture = await row("vault-id-tampered");
    const state = await resolveSealState(fixture.vault, fixture.root);
    expect(state.view).toEqual({ state: "unreadable", reason: "tampered" });
    expect(state.vaultId).not.toBeNull();
    expect(state.vaultId).not.toBe(fixture.vaultId);
  });

  it("reports an index entry without a store as broken", async () => {
    const fixture = await row("index-without-store");
    expect((await resolveSealState(fixture.vault, fixture.root)).view).toEqual({ state: "unreadable", reason: "broken" });
  });
});

describe("ensureVaultId", () => {
  it("issues a UUID once and returns the same id afterwards", async () => {
    const vault = await realpath(await mkdtemp(join(tmpdir(), "oms-vault-id-")));
    temps.push(vault);
    const first = await ensureVaultId(vault);
    expect(first).toMatch(VAULT_ID_PATTERN);
    expect(await ensureVaultId(vault)).toBe(first);
    expect(JSON.parse(await readFile(join(vault, SETTINGS_PATH), "utf8"))).toMatchObject({ version: 1, vaultId: first });
  });
});
