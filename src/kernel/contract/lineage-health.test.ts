import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestHex } from "./digest.js";
import { lineageHealth, lineageNeedsAttention, type LineageFinding } from "./lineage-health.js";
import { LINEAGE_FILE } from "./lineage.js";
import { stateDir } from "./state-dir.js";
import { sealContract } from "./store.js";
import type { VaultContract } from "./types.js";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";

function contract(max: number): VaultContract {
  return {
    folders: { Projects: { meaning: "projects", searchExclude: false } },
    properties: { rating: { meaning: "score", type: "number", default: false, required: true, rules: [{ kind: "range", min: 0, max }] } },
    templates: {
      Meeting: { source: "Templates/Meeting.md", sourceHash: `sha256:${"a".repeat(64)}`, applyFolder: "Meetings", requiredProperties: ["rating"], narrowedRules: {}, requiredHeadings: ["Agenda"] },
    },
  };
}

let base: string;
let root: string;
const saved = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"] };

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-lineage-health-")));
  root = join(base, "home", ".oms", "vaults");
  process.env["HOME"] = join(base, "home");
  process.env["USERPROFILE"] = join(base, "home");
});

afterEach(async () => {
  process.env["HOME"] = saved.HOME;
  process.env["USERPROFILE"] = saved.USERPROFILE;
  await rm(base, { recursive: true, force: true });
});

const seal = (max: number) => sealContract({ vaultRealPath: join(base, "vault"), vaultId: ID, contract: contract(max) }, root);
const generations = () => join(stateDir(root, ID), "generations");
const findings = async (): Promise<readonly LineageFinding[]> => (await lineageHealth(ID, root)).findings;

describe("lineage health", () => {
  it("reports a clean store with its counts and nothing to attend to", async () => {
    await seal(1);
    await seal(2);
    const health = await lineageHealth(ID, root);
    expect(health).toMatchObject({ events: 2, snapshots: 2, findings: [] });
    expect(health.snapshotBytes).toBeGreaterThan(0);
    expect(lineageNeedsAttention(health)).toBe(false);
  });

  it("reports nothing for a vault that was never sealed, and no health needs no attention", async () => {
    expect(await lineageHealth(ID, root)).toEqual({ events: 0, snapshots: 0, snapshotBytes: 0, findings: [] });
    expect(lineageNeedsAttention(null)).toBe(false);
  });

  it("names an unreadable lineage by its error code only", async () => {
    await seal(1);
    const path = join(stateDir(root, ID), "lineage", LINEAGE_FILE);
    await rm(path);
    await mkdir(path);
    const health = await lineageHealth(ID, root);
    expect(health).toMatchObject({ events: 0, snapshots: 0, snapshotBytes: 0 });
    expect(health.findings).toHaveLength(1);
    expect(health.findings[0]).toMatchObject({ kind: "lineage-unreadable", recovery: null });
    expect(health.findings[0]!.detail).not.toContain(base);
    expect(lineageNeedsAttention(health)).toBe(true);
  });

  it("offers recover for a missing snapshot of a kept generation, and nothing once its directory is gone", async () => {
    const first = await seal(1);
    await seal(2);
    await rm(join(generations(), digestHex(first.digest)), { recursive: true });
    expect(await findings()).toEqual([{ kind: "snapshot-missing", detail: `${first.digest} is in the lineage but has no snapshot`, recovery: "oms doctor lineage-recover" }]);
    await rm(join(root, `.${ID}.${first.seq}`), { recursive: true });
    expect(await findings()).toEqual([{ kind: "snapshot-missing", detail: `${first.digest} is in the lineage but has no snapshot`, recovery: null }]);
  });

  it("offers recover for a leftover temporary snapshot and nothing for any other stray entry", async () => {
    await seal(1);
    await mkdir(join(generations(), ".tmp-abc"));
    await writeFile(join(generations(), "stray"), "x");
    const found = await findings();
    expect(found.filter(finding => finding.kind === "snapshot-unexpected-entry").map(finding => [finding.detail, finding.recovery]).sort()).toEqual([
      [".tmp-abc", "oms doctor lineage-recover"],
      ["stray", null],
    ]);
    expect(lineageNeedsAttention({ events: 1, snapshots: 1, snapshotBytes: 1, findings: found })).toBe(true);
  });

  it("treats only the informational kinds as not needing attention", () => {
    const health = (kind: LineageFinding["kind"]) => ({ events: 0, snapshots: 0, snapshotBytes: 0, findings: [{ kind, detail: "", recovery: null }] });
    for (const kind of ["before-bootstrap", "snapshot-unsealed", "lineage-truncated-tail"] as const) expect(lineageNeedsAttention(health(kind))).toBe(false);
    for (const kind of ["lineage-unrecorded-seal", "lineage-seq-restart", "lineage-gap", "lineage-chain-broken", "lineage-corrupt", "lineage-unreadable", "snapshot-missing", "snapshot-unexpected-entry"] as const) {
      expect(lineageNeedsAttention(health(kind))).toBe(true);
    }
  });
});
