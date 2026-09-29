import { hostname } from "node:os";
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Digest } from "../conventions/canonical.js";
import { digestHex, manifestDigestOf, NO_DIGEST } from "./digest.js";
import { readSnapshot, snapshotInventory } from "./generation-snapshot.js";
import { lineageHealth, lineageNeedsAttention } from "./lineage-health.js";
import {
  appendLineageEvents,
  chainViolation,
  chainViolations,
  LINEAGE_FILE,
  lineageAppender,
  planLineageTail,
  readLineage,
  type LineageDraft,
  type LineageEvent,
  type LineageTailInput,
} from "./lineage.js";
import { stateDir } from "./state-dir.js";
import { bootstrapSnapshots, readIndex, recoverLineage, sealContract, type SealFs } from "./store.js";
import type { VaultContract } from "./types.js";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const FOREIGN: Digest = `sha256:${"e".repeat(64)}`;

function contract(max: number): VaultContract {
  return {
    folders: { Projects: { meaning: "projects", searchExclude: false } },
    properties: { rating: { meaning: "score", type: "number", default: false, required: true, rules: [{ kind: "range", min: 0, max }] } },
  };
}

let base: string;
let root: string;
let vault: string;
const saved = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"] };

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-seal-lineage-")));
  root = join(base, "home", ".oms", "vaults");
  vault = join(base, "vault");
  process.env["HOME"] = join(base, "home");
  process.env["USERPROFILE"] = join(base, "home");
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env["HOME"] = saved.HOME;
  process.env["USERPROFILE"] = saved.USERPROFILE;
  await rm(base, { recursive: true, force: true });
});

function seal(max: number, extra: Partial<Parameters<typeof sealContract>[0]> = {}, overrides: Parameters<typeof sealContract>[2] = {}) {
  return sealContract({ vaultRealPath: vault, vaultId: ID, contract: contract(max), ...extra }, root, overrides);
}

function lineagePath(): string {
  return join(stateDir(root, ID), "lineage", LINEAGE_FILE);
}

async function events(): Promise<readonly LineageEvent[]> {
  return (await readLineage(root, ID, "strict")).events;
}

async function generationDirs(): Promise<string[]> {
  return (await readdir(root)).filter(entry => /^\.[0-9a-f-]{36}\.\d{1,9}$/.test(entry)).sort();
}

async function findingKinds(): Promise<string[]> {
  return (await lineageHealth(ID, root)).findings.map(finding => finding.kind);
}

/** Real fs calls behind spies, so a test sees every call the seal makes. */
function spiedFs(): { fs: Required<SealFs>; calls: string[] } {
  const calls: string[] = [];
  const fs: Required<SealFs> = {
    rename: vi.fn(async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
      calls.push(`rename ${basename(String(from))} -> ${basename(String(to))}`);
      return rename(from, to);
    }),
    symlink: vi.fn(async (target: Parameters<typeof symlink>[0], path: Parameters<typeof symlink>[1]) => {
      calls.push(`symlink ${basename(String(path))}`);
      return symlink(target, path);
    }),
    rm: vi.fn(async (path: Parameters<typeof rm>[0], options?: Parameters<typeof rm>[1]) => {
      calls.push(`rm ${basename(String(path))}`);
      return rm(path, options);
    }),
    sync: vi.fn(async (directory: string) => {
      calls.push(`sync ${basename(directory)}`);
    }),
    snapshotRename: vi.fn(async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
      calls.push("snapshotRename");
      return rename(from, to);
    }),
  };
  return { fs, calls };
}

/** Rewrites the lineage to only its first `keep` lines, as if later events were lost. */
async function keepLineageLines(keep: number): Promise<void> {
  const lines = (await readFile(lineagePath(), "utf8")).split("\n").filter(line => line !== "");
  await writeFile(lineagePath(), `${lines.slice(0, keep).join("\n")}\n`);
}

/** Appends a sealed event for a digest the store never held, so the lineage no longer ends at P. */
async function appendForeignTail(parent: Digest): Promise<void> {
  await appendLineageEvents(root, ID, [{ kind: "sealed", generation: 99, parentDigest: parent, digest: FOREIGN, mutations: [], manifestDigests: {} }]);
}

describe("seal durability order", () => {
  it("publishes and fsyncs the snapshot, swaps and fsyncs the link, then records the event", async () => {
    await seal(1);
    const { fs, calls } = spiedFs();
    const onSealed = vi.fn(async (sealed: Parameters<ReturnType<typeof lineageAppender>>[0]) => {
      calls.push("onSealed");
      await lineageAppender()(sealed);
    });
    await seal(2, { onSealed }, { fs });
    const order = calls.filter(call => call === "snapshotRename" || call.startsWith("sync ") || call.startsWith(`rename .${ID}.link-tmp`) || call === "onSealed");
    expect(order).toEqual(["snapshotRename", "sync generations", `rename .${ID}.link-tmp -> ${ID}`, "sync vaults", "onSealed"]);
    expect(onSealed).toHaveBeenCalledOnce();
  });

  it("W1: a failed fsync after the snapshot publish aborts before the swap and leaves an unsealed snapshot", async () => {
    const first = await seal(1);
    const spied = spiedFs();
    const fs = { ...spied.fs, sync: vi.fn(async (directory: string) => {
      if (basename(directory) === "generations") throw new Error("fsync failed");
    }) };
    await expect(seal(2, {}, { fs })).rejects.toThrow("fsync failed");
    expect(await generationDirs()).toEqual([`.${ID}.1`]);
    expect((await events()).map(event => event.digest)).toEqual([first.digest]);
    expect((await snapshotInventory(root, ID)).digests).toHaveLength(2);
    const health = await lineageHealth(ID, root);
    expect(health.findings.map(finding => finding.kind)).toEqual(["snapshot-unsealed"]);
    expect(lineageNeedsAttention(health)).toBe(false);
  });
});

describe("a seal whose lineage event is not recorded (W2)", () => {
  async function unrecorded() {
    const sealed = [await seal(1), await seal(2), await seal(3)];
    const indexBefore = await readIndex(root);
    await rm(join(root, "index.json"));
    const failure = seal(4, { onSealed: async () => { throw new Error("disk full"); } });
    await expect(failure).rejects.toMatchObject({ code: "CONTRACT_LINEAGE_APPEND_FAILED", seq: 4 });
    return { sealed, indexBefore };
  }

  it("throws with the seq and digest, skips the index write and the GC, and releases the lock", async () => {
    await seal(1);
    await seal(2);
    await seal(3);
    await rm(join(root, "index.json"));
    let error: unknown;
    try {
      await seal(4, { onSealed: async () => { throw new Error("disk full"); } });
    } catch (caught: unknown) {
      error = caught;
    }
    const linked = await readFile(join(root, ID, "manifest.json"));
    expect(error).toMatchObject({ code: "CONTRACT_LINEAGE_APPEND_FAILED", seq: 4, digest: manifestDigestOf(linked) });
    expect((error as Error).message).toContain("oms doctor lineage-recover");
    expect((error as Error).message).toContain("disk full");
    expect(await readIndex(root)).toEqual({ state: "absent" });
    expect(await generationDirs()).toEqual([`.${ID}.2`, `.${ID}.3`, `.${ID}.4`]);
    expect((await readdir(root)).filter(entry => entry.endsWith(".lock"))).toEqual([]);
    expect(await findingKinds()).toEqual(["lineage-unrecorded-seal"]);
    expect((await lineageHealth(ID, root)).findings[0]?.recovery).toBe("oms doctor lineage-recover");
  });

  it("is recorded once by lineage-recover under refuse, and a rerun records nothing", async () => {
    const { sealed } = await unrecorded();
    const linked = manifestDigestOf(await readFile(join(root, ID, "manifest.json")));
    const recovered = await recoverLineage(root, ID, { policy: "refuse" });
    expect(recovered.anchors).toHaveLength(1);
    expect(recovered.anchors[0]).toMatchObject({ kind: "recovered", reason: "unrecorded-seal", generation: 4, parentDigest: sealed[2]!.digest, digest: linked });
    expect((await recoverLineage(root, ID, { policy: "refuse" })).anchors).toEqual([]);
    expect(await findingKinds()).toEqual([]);

    // W3: the next seal adds only its own event; no digest is recorded twice.
    const next = await seal(5);
    expect(next.anchors).toEqual([]);
    const recorded = await events();
    expect(recorded.map(event => event.digest)).toEqual([...sealed.map(result => result.digest), linked, next.digest]);
    expect(chainViolations(recorded, new Set())).toEqual([]);
  });

  it("is anchored by the next seal under reanchor, without a gap warning", async () => {
    const { sealed } = await unrecorded();
    const next = await seal(5);
    expect(next.warnings).toEqual([]);
    expect(next.anchors).toHaveLength(1);
    expect(next.anchors[0]).toMatchObject({ reason: "unrecorded-seal", parentDigest: sealed[2]!.digest, digest: next.parentDigest });
    expect((await events()).filter(event => event.digest === next.parentDigest)).toHaveLength(1);
    expect(await findingKinds()).toEqual([]);
  });

  it("stops the next seal under refuse with CONTRACT_LINEAGE_GAP and nothing written", async () => {
    await unrecorded();
    const before = await readFile(lineagePath(), "utf8");
    await expect(seal(5, { lineageGapPolicy: "refuse" })).rejects.toMatchObject({ code: "CONTRACT_LINEAGE_GAP", guidance: "oms doctor lineage-reanchor" });
    expect(await readFile(lineagePath(), "utf8")).toBe(before);
    expect(await generationDirs()).toEqual([`.${ID}.2`, `.${ID}.3`, `.${ID}.4`]);
  });
});

describe("digests", () => {
  it("names the same generation in the result, the lineage, the snapshot and the manifest, and the next seal accepts it as parent", async () => {
    const first = await seal(1);
    expect(first.parentDigest).toBe(NO_DIGEST);
    const manifest = await readFile(join(root, `.${ID}.1`, "manifest.json"));
    expect(manifestDigestOf(manifest)).toBe(first.digest);
    expect((await events()).at(-1)?.digest).toBe(first.digest);
    expect(await readdir(join(stateDir(root, ID), "generations"))).toEqual([digestHex(first.digest)]);
    expect(`sha256:${digestHex(first.digest)}`).toBe(first.digest);
    const second = await seal(2, { expectedParentDigest: first.digest });
    expect(second.parentDigest).toBe(first.digest);
    expect((await events()).at(-1)).toMatchObject({ kind: "sealed", parentDigest: first.digest, digest: second.digest, generation: 2 });
  });

  it("never writes to the evolution state", async () => {
    await seal(1);
    await seal(2);
    expect((await readdir(stateDir(root, ID))).sort()).toEqual(["generations", "lineage"]);
  });
});

describe("lineage file damage", () => {
  it("warns about a cut-short last line once, drops it on append, and keeps eventSeq increasing", async () => {
    await seal(1);
    await appendFile(lineagePath(), '{"eventSeq":7,"kind":"seal');
    expect(await findingKinds()).toEqual(["lineage-truncated-tail"]);
    const second = await seal(2);
    expect(second.warnings).toEqual(["lineage-truncated-tail"]);
    const third = await seal(3);
    expect(third.warnings).toEqual([]);
    const read = await readLineage(root, ID, "strict");
    expect(read.events.map(event => event.eventSeq)).toEqual([1, 2, 3]);
    expect(await readFile(lineagePath(), "utf8")).not.toContain('"kind":"seal\n');
    expect(await findingKinds()).toEqual([]);
  });

  it("keeps a whole last event that lacks only its newline and appends after it", async () => {
    await seal(1);
    const text = await readFile(lineagePath(), "utf8");
    await writeFile(lineagePath(), text.slice(0, -1));
    const second = await seal(2);
    expect(second.warnings).toEqual([]);
    expect((await events()).map(event => event.eventSeq)).toEqual([1, 2]);
  });

  it("does not repair a corrupt middle line: the seal and the recovery both refuse", async () => {
    await seal(1);
    await seal(2);
    const [first, second] = (await readFile(lineagePath(), "utf8")).split("\n");
    await writeFile(lineagePath(), `${first}\nnot json\n${second}\n`);
    const before = await readFile(lineagePath(), "utf8");
    await expect(seal(3)).rejects.toMatchObject({ code: "EVOLUTION_LINEAGE_CORRUPT" });
    await expect(recoverLineage(root, ID, { policy: "reanchor" })).rejects.toMatchObject({ code: "EVOLUTION_LINEAGE_CORRUPT" });
    expect(await readFile(lineagePath(), "utf8")).toBe(before);
    expect(await findingKinds()).toContain("lineage-corrupt");
  });

  it("flags a bootstrap anchor whose parent is not retained as a broken chain", async () => {
    const first = await seal(1);
    await appendLineageEvents(root, ID, [{ kind: "recovered", reason: "bootstrap", generation: null, parentDigest: FOREIGN, digest: first.digest, mutations: [], manifestDigests: {} }]);
    const health = await lineageHealth(ID, root);
    expect(health.findings.filter(finding => finding.kind === "lineage-chain-broken").map(finding => finding.detail)).toEqual(["bootstrap anchor 2 names a parent that is not retained"]);
    expect(lineageNeedsAttention(health)).toBe(true);
  });
});

describe("lineage gaps", () => {
  it("7-a: refuse leaves the store and the lineage untouched and makes no fs call but the lock removal", async () => {
    const first = await seal(1);
    await seal(2);
    await appendForeignTail(first.digest);
    const lineage = await readFile(lineagePath(), "utf8");
    const snapshots = await readdir(join(stateDir(root, ID), "generations"));
    const { fs, calls } = spiedFs();
    await expect(seal(3, { lineageGapPolicy: "refuse" }, { fs })).rejects.toMatchObject({ code: "CONTRACT_LINEAGE_GAP", tailDigest: FOREIGN });
    expect(calls).toEqual([`rm .${ID}.lock`]);
    expect(await readFile(lineagePath(), "utf8")).toBe(lineage);
    expect(await readdir(join(stateDir(root, ID), "generations"))).toEqual(snapshots);
    expect(await generationDirs()).toEqual([`.${ID}.1`, `.${ID}.2`]);
    expect(await findingKinds()).toContain("lineage-gap");
  });

  it("7-b: reanchor records a gap anchor from the foreign tail, warns, then seals on it", async () => {
    const first = await seal(1);
    const second = await seal(2);
    await appendForeignTail(first.digest);
    const third = await seal(3);
    expect(third.warnings).toEqual(["lineage-gap-reanchored"]);
    expect(third.anchors).toEqual([expect.objectContaining({ reason: "gap-anchor", parentDigest: NO_DIGEST, digest: second.digest, gapFrom: FOREIGN })]);
    const recorded = await events();
    expect(recorded.at(-1)).toMatchObject({ kind: "sealed", parentDigest: second.digest, digest: third.digest });
    const [foreign, anchor, sealed] = recorded.slice(-3);
    expect(chainViolation(foreign, anchor!, new Set())).toBeNull();
    expect(chainViolation(anchor, sealed!, new Set())).toBeNull();
  });

  it("7-b: reanchors a lineage whose events after N-2 were lost", async () => {
    const first = await seal(1);
    await seal(2);
    const third = await seal(3);
    await keepLineageLines(1);
    // Generation 2's snapshot lost its event with the rest of the lineage, so it reads as unsealed.
    expect(await findingKinds()).toEqual(["lineage-gap", "snapshot-unsealed"]);
    const fourth = await seal(4);
    expect(fourth.warnings).toEqual(["lineage-gap-reanchored"]);
    expect(fourth.anchors[0]).toMatchObject({ reason: "gap-anchor", digest: third.digest, gapFrom: first.digest });
  });

  it("7-c: a gap is not anchored by lineage-recover under refuse; only lineage-reanchor repairs it", async () => {
    const first = await seal(1);
    const second = await seal(2);
    await appendForeignTail(first.digest);
    const before = await readFile(lineagePath(), "utf8");
    await expect(recoverLineage(root, ID, { policy: "refuse" })).rejects.toMatchObject({ code: "CONTRACT_LINEAGE_GAP", parentDigest: second.digest });
    expect(await readFile(lineagePath(), "utf8")).toBe(before);
    const repaired = await recoverLineage(root, ID, { policy: "reanchor" });
    expect(repaired.anchors).toEqual([expect.objectContaining({ reason: "gap-anchor", digest: second.digest, gapFrom: FOREIGN })]);
    expect((await recoverLineage(root, ID, { policy: "refuse" })).anchors).toEqual([]);
  });

  it("7-i: an anchor recorded before a failed swap is not recorded again on retry", async () => {
    const first = await seal(1);
    await seal(2);
    await appendForeignTail(first.digest);
    const fs = { ...spiedFs().fs, rename: vi.fn(async () => { throw new Error("swap failed"); }) };
    await expect(seal(3, {}, { fs })).rejects.toThrow("swap failed");
    expect((await events()).filter(event => event.reason === "gap-anchor")).toHaveLength(1);
    const retry = await seal(3);
    expect(retry.anchors).toEqual([]);
    expect(retry.warnings).toEqual([]);
    expect((await events()).filter(event => event.reason === "gap-anchor")).toHaveLength(1);
  });
});

describe("store shapes", () => {
  it("7-e: a lost link restarts at seq 1 and the lineage records the restart", async () => {
    await seal(1);
    const second = await seal(2);
    await rm(join(root, ID));
    expect(await findingKinds()).toEqual(["lineage-seq-restart"]);
    const restarted = await seal(3);
    expect(restarted).toMatchObject({ seq: 1, parentDigest: NO_DIGEST });
    const tail = (await events()).slice(-2);
    expect(tail[0]).toMatchObject({ kind: "recovered", reason: "seq-restart", parentDigest: NO_DIGEST, digest: NO_DIGEST, priorTail: second.digest });
    expect(tail[1]).toMatchObject({ kind: "sealed", parentDigest: NO_DIGEST, digest: restarted.digest, generation: 1 });
    expect(chainViolations(await events(), new Set())).toEqual([]);
  });

  it("7-f: seals on a legacy directory as its parent and migrates it to .<id>.0", async () => {
    const legacy = await seal(1);
    await rm(join(root, ID));
    await cp(join(root, `.${ID}.1`), join(root, ID), { recursive: true });
    await rm(join(root, `.${ID}.1`), { recursive: true });
    const next = await seal(2);
    expect(next).toMatchObject({ seq: 1, parentDigest: legacy.digest, anchors: [] });
    expect(await generationDirs()).toEqual([`.${ID}.0`, `.${ID}.1`]);
    expect(manifestDigestOf(await readFile(join(root, `.${ID}.0`, "manifest.json")))).toBe(legacy.digest);
  });

  it("7-f: bootstrap snapshots a legacy directory with an anchor that has no generation", async () => {
    const legacy = await seal(1);
    await rm(join(root, ID));
    await rename(join(root, `.${ID}.1`), join(root, ID));
    await rm(stateDir(root, ID), { recursive: true });
    expect(await findingKinds()).toEqual(["before-bootstrap"]);
    const booted = await bootstrapSnapshots(root, ID);
    expect(booted.snapshots).toBe(1);
    expect(booted.anchors).toEqual([expect.objectContaining({ kind: "recovered", reason: "bootstrap", proposer: "pre-lineage", generation: null, parentDigest: NO_DIGEST, digest: legacy.digest })]);
    expect(await findingKinds()).toEqual([]);
  });

  it("7-g: a corrupt snapshot of the linked generation stops the seal with nothing changed", async () => {
    const first = await seal(1);
    const snapshot = join(stateDir(root, ID), "generations", digestHex(first.digest));
    const file = (await readdir(snapshot)).find(entry => entry !== "manifest.json" && entry !== "templates")!;
    await writeFile(join(snapshot, file), "tampered");
    const lineage = await readFile(lineagePath(), "utf8");
    await expect(seal(2)).rejects.toMatchObject({ code: "CONTRACT_SNAPSHOT_CORRUPT", digest: first.digest });
    expect(await generationDirs()).toEqual([`.${ID}.1`]);
    expect(await readFile(lineagePath(), "utf8")).toBe(lineage);
    expect(await readFile(join(snapshot, file), "utf8")).toBe("tampered");
  });

  it("refuses a bootstrap while another seal holds the lock", async () => {
    await seal(1);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, `.${ID}.lock`), JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now() }));
    await expect(bootstrapSnapshots(root, ID)).rejects.toThrow(/^CONTRACT_SEAL_BUSY/);
    await expect(recoverLineage(root, ID, { policy: "reanchor" })).rejects.toThrow(/^CONTRACT_SEAL_BUSY/);
  });
});

describe("lineage replay", () => {
  /** Replays the lineage in eventSeq order and reads every installed digest's bytes back from its snapshot. */
  async function replay(): Promise<Digest[]> {
    const recorded = await events();
    expect(chainViolations(recorded, new Set())).toEqual([]);
    const installed = recorded.map(event => event.digest).filter((digest): digest is Digest => digest !== NO_DIGEST);
    for (const digest of installed) {
      const read = await readSnapshot(root, ID, digest);
      expect(read.state).toBe("ok");
      if (read.state === "ok") expect(manifestDigestOf(read.manifestBytes)).toBe(digest);
    }
    return installed;
  }

  it("rebuilds every sealed digest after N-2 and older directories were collected", async () => {
    const sealed = [];
    for (const max of [1, 2, 3, 4, 5]) sealed.push(await seal(max));
    expect(await generationDirs()).toEqual([`.${ID}.4`, `.${ID}.5`]);
    const installed = await replay();
    expect(installed).toEqual(sealed.map(result => result.digest));
    expect(installed.at(-1)).toBe(manifestDigestOf(await readFile(join(root, ID, "manifest.json"))));
  });

  it("replays across a seq restart by the parent chain, not by seq", async () => {
    const before = [await seal(1), await seal(2)];
    await rm(join(root, ID));
    expect(await findingKinds()).toEqual(["lineage-seq-restart"]);
    const after = [await seal(3), await seal(4)];
    expect(after.map(result => result.seq)).toEqual([1, 2]);
    expect(await replay()).toEqual([...before, ...after].map(result => result.digest));
    expect(await findingKinds()).toEqual([]);
  });

  it("accepts a bootstrap anchor whose parent is none or a retained generation", () => {
    const D1: Digest = `sha256:${"4".repeat(64)}`;
    const D2: Digest = `sha256:${"5".repeat(64)}`;
    const prior: LineageEvent = { eventSeq: 1, kind: "sealed", generation: 1, parentDigest: NO_DIGEST, digest: FOREIGN, mutations: [], manifestDigests: {} };
    const anchor = (parentDigest: Digest | typeof NO_DIGEST): LineageEvent =>
      ({ eventSeq: 2, kind: "recovered", reason: "bootstrap", generation: null, parentDigest, digest: D2, mutations: [], manifestDigests: {} });
    expect(chainViolation(prior, anchor(NO_DIGEST), new Set())).toBeNull();
    expect(chainViolation(prior, anchor(D1), new Set([D1, D2]))).toBeNull();
    expect(chainViolation(prior, anchor(D1), new Set([D2]))).toBe("bootstrap anchor 2 names a parent that is not retained");
  });
});

describe("planLineageTail", () => {
  const P: Digest = `sha256:${"1".repeat(64)}`;
  const N1: Digest = `sha256:${"2".repeat(64)}`;
  const OTHER: Digest = `sha256:${"3".repeat(64)}`;
  let seq = 0;
  const event = (draft: Partial<LineageDraft> & Pick<LineageDraft, "digest">): LineageEvent => ({
    eventSeq: (seq += 1),
    kind: "sealed",
    generation: seq,
    parentDigest: NO_DIGEST,
    mutations: [],
    manifestDigests: {},
    ...draft,
  });
  const input = (parentDigest: LineageTailInput["parentDigest"], previousDigest: Digest | null = N1): LineageTailInput => ({
    parentDigest,
    parentGeneration: parentDigest === NO_DIGEST ? null : 3,
    parentManifest: {},
    previousDigest,
    retained: new Set([P, N1]),
  });

  it.each([
    ["an empty lineage", [] as LineageEvent[], input(P), "none", []],
    ["a lineage ending at P", [event({ digest: P })], input(P), "none", []],
    ["a seq-restart tail with nothing linked", [event({ digest: N1 }), event({ kind: "recovered", reason: "seq-restart", digest: NO_DIGEST, priorTail: N1 })], input(NO_DIGEST), "none", []],
    ["a sealed tail with nothing linked", [event({ digest: N1 })], input(NO_DIGEST), "append", []],
    ["a tail at N-1 (unrecorded seal)", [event({ digest: N1 })], input(P), "append", []],
    ["a foreign tail (gap)", [event({ digest: OTHER })], input(P), "append", ["lineage-gap-reanchored"]],
    ["a tail at N-1 when N-1 is unknown (gap)", [event({ digest: N1 })], input(P, null), "append", ["lineage-gap-reanchored"]],
    ["a tail at N-1 that breaks the chain (gap)", [event({ digest: OTHER }), event({ parentDigest: P, digest: N1 })], input(P), "append", ["lineage-gap-reanchored"]],
  ])("reanchor, %s", (_, events, tailInput, action, warnings) => {
    const plan = planLineageTail(events, tailInput, "reanchor");
    expect(plan.action).toBe(action);
    if (plan.action === "append") {
      expect(plan.warnings).toEqual(warnings);
      expect(plan.anchors).toHaveLength(1);
    }
  });

  it("refuses every non-current outcome under refuse, naming the tail and P", () => {
    const cases: [LineageEvent[], LineageTailInput][] = [
      [[event({ digest: N1 })], input(NO_DIGEST)],
      [[event({ digest: N1 })], input(P)],
      [[event({ digest: OTHER })], input(P)],
    ];
    for (const [tail, tailInput] of cases) {
      expect(planLineageTail(tail, tailInput, "refuse")).toEqual({ action: "refuse", tailDigest: tail.at(-1)!.digest, parentDigest: tailInput.parentDigest });
    }
    expect(planLineageTail([event({ digest: P })], input(P), "refuse")).toEqual({ action: "none", anchors: [], warnings: [] });
  });

  it("drafts anchors that keep the chain valid, and a sealed event with no parent is valid only at a restart", () => {
    const tail = event({ digest: N1 });
    const restart = planLineageTail([tail], input(NO_DIGEST), "reanchor");
    expect(restart).toMatchObject({ anchors: [{ reason: "seq-restart", parentDigest: NO_DIGEST, digest: NO_DIGEST, priorTail: N1 }] });
    const anchored = restart.action === "append" ? { eventSeq: tail.eventSeq + 1, ...restart.anchors[0]! } : tail;
    const fresh = { ...event({ parentDigest: NO_DIGEST, digest: P }), eventSeq: tail.eventSeq + 2 };
    expect(chainViolations([tail, anchored, fresh], new Set())).toEqual([]);
    expect(chainViolations([tail, fresh], new Set())).toEqual([`sealed event ${fresh.eventSeq} does not follow ${N1}`]);
    const unrecorded = planLineageTail([tail], input(P), "reanchor");
    expect(unrecorded).toMatchObject({ anchors: [{ reason: "unrecorded-seal", parentDigest: N1, digest: P, generation: 3 }] });
    const gap = planLineageTail([event({ digest: OTHER })], input(P), "reanchor");
    expect(gap).toMatchObject({ anchors: [{ reason: "gap-anchor", parentDigest: NO_DIGEST, digest: P, gapFrom: OTHER }] });
  });
});
