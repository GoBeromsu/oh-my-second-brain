import { createHash } from "node:crypto";
import { appendFile, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GAP_EVENTS_FILE, choiceGapId, openGaps, readGapDraft, readGapLedger, recordGaps, resolveGap, writeGapDraft,
  type GapEvent, type GapInput,
} from "./gap-ledger.js";
import { stateDir } from "./state-dir.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: vi.fn(actual.unlink), open: vi.fn(actual.open), readdir: vi.fn(actual.readdir) };
});

const VAULT_ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const NOTE_REV = `sha256:${"a".repeat(64)}`;
const CONTRACT_REV = `sha256:${"b".repeat(64)}`;

let base: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-gap-ledger-")));
  root = join(base, "home", ".oms", "vaults");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const gapsDir = (): string => join(stateDir(root, VAULT_ID), "gaps");
const ledgerPath = (): string => join(gapsDir(), GAP_EVENTS_FILE);

function gap(field: string, extra: Partial<GapInput> = {}): GapInput {
  return {
    notePath: "Inbox/a.md",
    noteRevision: NOTE_REV,
    contractRevision: CONTRACT_REV,
    axis: "property",
    kind: "no-fit",
    chosen: null,
    wanted: { field, value: "x" },
    reason: "dropped: unknown-property",
    ...extra,
  };
}

function ids(...values: string[]): () => string {
  const queue = [...values];
  return () => queue.shift()!;
}

describe("gap ledger", () => {
  it("reads an absent ledger as empty and creates nothing", async () => {
    expect(await readGapLedger(root, VAULT_ID)).toEqual({ events: [], corrupt: [] });
    await expect(stat(root)).rejects.toThrow();
    expect(await readGapDraft(root, VAULT_ID, `draft-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.md`)).toBeNull();
  });

  it("records gaps in one append with the injected clock and ids, and replays them identically", async () => {
    const records = await recordGaps(root, VAULT_ID, [gap("mood"), gap("tags", { axis: "value", wanted: { field: "tags", value: ["a", 1, null] } })], { now: () => 42, newId: ids("g1", "g2") });
    expect(records.map(record => [record.id, record.at, record.wanted.field])).toEqual([["g1", 42, "mood"], ["g2", 42, "tags"]]);
    const first = await readGapLedger(root, VAULT_ID);
    expect(first.corrupt).toEqual([]);
    expect(first.events.map(event => [event.type, event.id])).toEqual([["gap", "g1"], ["gap", "g2"]]);
    expect(openGaps(first.events)).toEqual(records);
    const second = await readGapLedger(root, VAULT_ID);
    expect(openGaps(second.events)).toEqual(openGaps(first.events));
    const text = await readFile(ledgerPath(), "utf8");
    expect(text.split("\n")).toHaveLength(3);
  });

  it("appends nothing for an empty list", async () => {
    expect(await recordGaps(root, VAULT_ID, [])).toEqual([]);
    await expect(stat(root)).rejects.toThrow();
  });

  it("closes a resolved gap for good and keeps the latest record of a repeated id", async () => {
    await recordGaps(root, VAULT_ID, [gap("a"), gap("b")], { now: () => 1, newId: ids("g1", "g2") });
    await resolveGap(root, VAULT_ID, "g1", "added to the contract", { now: () => 2 });
    await recordGaps(root, VAULT_ID, [gap("a2"), gap("b2")], { now: () => 3, newId: ids("g1", "g2") });
    await resolveGap(root, VAULT_ID, "unknown", "harmless");
    const open = openGaps((await readGapLedger(root, VAULT_ID)).events);
    expect(open.map(record => [record.id, record.wanted.field, record.at])).toEqual([["g2", "b2", 3]]);
  });

  it("skips and reports a cut-short last line, and the next append starts on a new line", async () => {
    await recordGaps(root, VAULT_ID, [gap("a")], { now: () => 1, newId: ids("g1") });
    await appendFile(ledgerPath(), '{"type":"gap","id":"g-cut');
    expect(await readGapLedger(root, VAULT_ID)).toMatchObject({ corrupt: [2] });
    await recordGaps(root, VAULT_ID, [gap("b")], { now: () => 2, newId: ids("g3") });
    const ledger = await readGapLedger(root, VAULT_ID);
    expect(ledger.corrupt).toEqual([2]);
    expect(ledger.events.map(event => event.id)).toEqual(["g1", "g3"]);
    expect(await readFile(ledgerPath(), "utf8")).toContain('"g-cut\n{');
  });

  it("reports every malformed event as corrupt without throwing", async () => {
    await recordGaps(root, VAULT_ID, [gap("a")], { now: () => 1, newId: ids("g1") });
    const valid = { type: "gap", id: "x", at: 1, ...gap("a") };
    const bad: unknown[] = [
      "not json", null, [], { ...valid, id: "" }, { ...valid, at: "1" }, { ...valid, type: "other" },
      { type: "resolved", id: "x", at: 1 }, { ...valid, notePath: 1 }, { ...valid, noteRevision: "sha256:zz" },
      { ...valid, contractRevision: 7 }, { ...valid, axis: "shape" }, { ...valid, kind: "maybe" }, { ...valid, chosen: 3 },
      { ...valid, wanted: null }, { ...valid, wanted: { field: 1 } }, { ...valid, wanted: { field: "a", value: { deep: 1 } } },
      { ...valid, wanted: { field: "a", value: [{}] } }, { ...valid, draftRef: "../escape.md" },
    ];
    await appendFile(ledgerPath(), `${bad.map(entry => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n")}\n\n`);
    const ledger = await readGapLedger(root, VAULT_ID);
    expect(ledger.events.map(event => event.id)).toEqual(["g1"]);
    expect(ledger.corrupt).toEqual(bad.map((_, index) => index + 2));
  });

  it("records and reads back the kept and fixed kinds, and still reads events an earlier version wrote as no-fit", async () => {
    await recordGaps(root, VAULT_ID, [
      gap("mood", { kind: "kept", reason: "kept: unknown-property" }),
      gap("size", { axis: "value", kind: "fixed", wanted: { field: "size", value: "12" }, reason: "fixed: type" }),
    ], { now: () => 1, newId: ids("g1", "g2") });
    const legacy = { type: "gap", id: "g0", at: 0, ...gap("old") };
    await appendFile(ledgerPath(), `${JSON.stringify(legacy)}\n`);
    const ledger = await readGapLedger(root, VAULT_ID);
    expect(ledger.corrupt).toEqual([]);
    expect(ledger.events.map(event => event.type === "gap" ? [event.id, event.kind] : [event.id])).toEqual([["g1", "kept"], ["g2", "fixed"], ["g0", "no-fit"]]);
    expect(openGaps(ledger.events).find(record => record.id === "g2")?.wanted).toEqual({ field: "size", value: "12" });
  });

  it("accepts a resolved event and a gap with a well-formed draft ref", async () => {
    const draftRef = await writeGapDraft(root, VAULT_ID, "# held\n", { newId: () => "12345678-1234-4234-8234-123456789abc" });
    await recordGaps(root, VAULT_ID, [gap("a", { draftRef })], { newId: ids("g1") });
    await resolveGap(root, VAULT_ID, "g1", "fixed");
    const events: readonly GapEvent[] = (await readGapLedger(root, VAULT_ID)).events;
    expect(events.map(event => event.type)).toEqual(["gap", "resolved"]);
    expect(events[0]).toMatchObject({ draftRef });
  });

  it("keeps a draft beside the ledger and reads it back by ref", async () => {
    const draftRef = await writeGapDraft(root, VAULT_ID, "---\nmood: odd\n---\nbody\n", { newId: () => "12345678-1234-4234-8234-123456789abc" });
    expect(draftRef).toBe("draft-12345678-1234-4234-8234-123456789abc.md");
    expect(await readdir(gapsDir())).toEqual([draftRef]);
    expect((await stat(join(gapsDir(), draftRef))).mode & 0o777).toBe(0o600);
    expect(await readGapDraft(root, VAULT_ID, draftRef)).toBe("---\nmood: odd\n---\nbody\n");
    expect(await readGapDraft(root, VAULT_ID, "draft-00000000-0000-0000-0000-000000000000.md")).toBeNull();
    expect(await readGapDraft(root, VAULT_ID, "../events.jsonl")).toBeNull();
  });

  it("keeps appending past the read window and reads the newest events, marked truncated", async () => {
    await recordGaps(root, VAULT_ID, [gap("a"), gap("b")], { now: () => 1, newId: ids("g1", "g2") });
    await appendFile(ledgerPath(), "not json\n");
    await recordGaps(root, VAULT_ID, [gap("c")], { now: () => 2, newId: ids("g3") });
    const whole = await readGapLedger(root, VAULT_ID);
    expect(whole).toEqual({ events: expect.any(Array), corrupt: [3] });
    const size = (await stat(ledgerPath())).size;
    const lastLine = (await readFile(ledgerPath(), "utf8")).trimEnd().split("\n").at(-1)!;
    // A window a few bytes wider than the last two lines cuts into the second event mid-line.
    const window = lastLine.length + "not json\n".length + 2;
    const read = await readGapLedger(root, VAULT_ID, { maxBytes: window });
    expect(read.truncated).toBe(true);
    expect(read.events.map(event => event.id)).toEqual(["g3"]);
    expect(read.corrupt).toEqual([3]);
    const newest = await readGapLedger(root, VAULT_ID, { maxBytes: lastLine.length + 1 });
    expect(newest).toMatchObject({ corrupt: [], truncated: true });
    expect(newest.events.map(event => event.id)).toEqual(["g3"]);
    await recordGaps(root, VAULT_ID, [gap("d")], { now: () => 3, newId: ids("g4") });
    expect((await stat(ledgerPath())).size).toBeGreaterThan(size);
    expect((await readGapLedger(root, VAULT_ID, { maxBytes: window })).events.map(event => event.id)).toEqual(["g4"]);
  });

  it("appends to and reads the newest window of a ledger past the default cap without throwing", async () => {
    await recordGaps(root, VAULT_ID, [gap("a")], { newId: ids("g1") });
    await truncate(ledgerPath(), 16 * 1024 * 1024 + 1);
    await recordGaps(root, VAULT_ID, [gap("b")], { newId: ids("g2") });
    const read = await readGapLedger(root, VAULT_ID);
    expect(read.truncated).toBe(true);
    expect(read.events.map(event => event.id)).toEqual(["g2"]);
  });

  it("records a repeated template choice once, keeps it closed once resolved, and records it anew under a new contract", async () => {
    const choice = (candidates: string[], extra: Partial<GapInput> = {}): GapInput =>
      gap("template", { axis: "template", kind: "choice", wanted: { field: "template", value: candidates }, ...extra });
    const first = await recordGaps(root, VAULT_ID, [choice(["Standup", "Review"])], { now: () => 1 });
    const id = choiceGapId(choice(["Review", "Standup"]));
    expect(first.map(record => record.id)).toEqual([id]);
    expect((await readdir(gapsDir())).filter(name => name.endsWith(`.${id}.seen`))).toHaveLength(1);
    const again = await recordGaps(root, VAULT_ID, [choice(["Review", "Standup"], { noteRevision: `sha256:${"c".repeat(64)}` }), gap("mood")], { now: () => 2, newId: ids("g1") });
    expect(again.map(record => record.id)).toEqual([id, "g1"]);
    expect((await readGapLedger(root, VAULT_ID)).events.map(event => event.id)).toEqual([id, "g1"]);
    await resolveGap(root, VAULT_ID, id, "picked Review");
    await recordGaps(root, VAULT_ID, [choice(["Review", "Standup"])]);
    expect(openGaps((await readGapLedger(root, VAULT_ID)).events).map(record => record.id)).toEqual(["g1"]);
    const revised = choice(["Review", "Standup"], { contractRevision: `sha256:${"d".repeat(64)}` });
    expect(choiceGapId(revised)).not.toBe(id);
    expect(choiceGapId(choice(["Review", "Daily"]))).not.toBe(id);
    await recordGaps(root, VAULT_ID, [revised]);
    expect(openGaps((await readGapLedger(root, VAULT_ID)).events).map(record => record.id)).toEqual(["g1", choiceGapId(revised)]);
  });

  describe("choice markers", () => {
    const choice = (): GapInput => gap("template", { axis: "template", kind: "choice", wanted: { field: "template", value: ["Review", "Standup"] } });
    const id = choiceGapId(choice());
    const markers = async (): Promise<string[]> => (await readdir(gapsDir())).filter(name => name.endsWith(".seen"));
    const recorded = async (): Promise<string[]> => (await readGapLedger(root, VAULT_ID)).events.map(event => event.id);

    it("records a repeated choice anew once the ledger is moved aside, and sweeps the old markers", async () => {
      await recordGaps(root, VAULT_ID, [choice()], { now: () => 1 });
      await recordGaps(root, VAULT_ID, [choice()], { now: () => 2 });
      expect(await recorded()).toEqual([id]);
      const [old] = await markers();
      await writeFile(join(gapsDir(), `${id}.seen`), "");
      await rename(ledgerPath(), join(gapsDir(), "events.2026-09-29.jsonl"));

      await recordGaps(root, VAULT_ID, [choice()], { now: () => 3 });
      expect(await recorded()).toEqual([id]);
      const current = await markers();
      expect(current).toHaveLength(1);
      expect(current).not.toContain(old);
      expect(current[0]!.endsWith(`.${id}.seen`)).toBe(true);
      await recordGaps(root, VAULT_ID, [choice()], { now: () => 4 });
      expect(await recorded()).toEqual([id]);
    });

    it("records a repeated choice anew once its event falls out of the read window", async () => {
      await recordGaps(root, VAULT_ID, [choice()], { now: () => 1 });
      await truncate(ledgerPath(), 16 * 1024 * 1024 + 1);
      await recordGaps(root, VAULT_ID, [choice()], { now: () => 2 });
      expect(await recorded()).toEqual([id]);
      await recordGaps(root, VAULT_ID, [choice()], { now: () => 3 });
      expect((await readGapLedger(root, VAULT_ID)).events.map(event => event.at)).toEqual([2]);
    });

    it("counts no marker while the ledger's only line is cut short", async () => {
      await recordGaps(root, VAULT_ID, [choice()], { now: () => 1 });
      const [old] = await markers();
      const partial = '{"type":"gap"';
      await writeFile(ledgerPath(), partial);
      // Named as if the cut-short line identified the ledger.
      const unclosed = createHash("sha256").update(partial).digest("hex").slice(0, 16);
      await writeFile(join(gapsDir(), `${unclosed}.${id}.seen`), "0");

      await recordGaps(root, VAULT_ID, [choice()], { now: () => 2 });
      expect((await readGapLedger(root, VAULT_ID)).events.map(event => event.at)).toEqual([2]);
      const current = await markers();
      expect(current).toHaveLength(1);
      expect(current).not.toContain(old);
      expect(current[0]!.startsWith(`${unclosed}.`)).toBe(false);
    });

    it("appends an open choice once more over legacy markers and keeps a resolved one closed", async () => {
      const other = gap("template", { notePath: "Inbox/b.md", axis: "template", kind: "choice", wanted: { field: "template", value: ["Review", "Standup"] } });
      const otherId = choiceGapId(other);
      await recordGaps(root, VAULT_ID, [choice(), other], { now: () => 1 });
      await resolveGap(root, VAULT_ID, otherId, "chose Review", { now: () => 2 });
      for (const marker of await markers()) await rm(join(gapsDir(), marker));
      await writeFile(join(gapsDir(), `${id}.seen`), "");
      await writeFile(join(gapsDir(), `${otherId}.seen`), "");

      await recordGaps(root, VAULT_ID, [choice(), other], { now: () => 3 });
      expect(await recorded()).toEqual([id, otherId, otherId, id, otherId]);
      expect(openGaps((await readGapLedger(root, VAULT_ID)).events).map(record => record.id)).toEqual([id]);
      await recordGaps(root, VAULT_ID, [choice(), other], { now: () => 4 });
      expect(await recorded()).toHaveLength(5);
    });

    it("still resolves with the committed records when pruning a stale marker fails", async () => {
      await recordGaps(root, VAULT_ID, [choice()], { now: () => 1 });
      const [old] = await markers();
      await rename(ledgerPath(), join(gapsDir(), "events.2026-09-29.jsonl"));
      vi.mocked(unlink).mockRejectedValueOnce(Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }));

      const records = await recordGaps(root, VAULT_ID, [choice()], { now: () => 2 });
      expect(records.map(record => record.id)).toEqual([id]);
      expect(vi.mocked(unlink)).toHaveBeenCalledWith(join(gapsDir(), old!));
      expect(await recorded()).toEqual([id]);
      const current = await markers();
      expect(current).toHaveLength(2);
      expect(current).toContain(old);
    });

    it("still resolves with the committed records when listing markers to prune fails", async () => {
      await recordGaps(root, VAULT_ID, [choice()], { now: () => 1 });
      const [old] = await markers();
      await rename(ledgerPath(), join(gapsDir(), "events.2026-09-29.jsonl"));
      vi.mocked(readdir).mockRejectedValueOnce(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));

      const records = await recordGaps(root, VAULT_ID, [choice()], { now: () => 2 });
      expect(records.map(record => record.id)).toEqual([id]);
      expect(vi.mocked(readdir)).toHaveBeenCalledWith(gapsDir());
      expect(await recorded()).toEqual([id]);
      const current = await markers();
      expect(current).toHaveLength(2);
      expect(current).toContain(old);
    });

    it("keeps the committed event when writing its marker fails, and re-appends it once more", async () => {
      // A prior, unrelated append settles the state dir and the ledger so the two opens
      // below are unambiguously the append's and then the marker's.
      await recordGaps(root, VAULT_ID, [gap("warmup")], { now: () => 0, newId: ids("w1") });
      const realOpen = vi.mocked(open).getMockImplementation()!;
      vi.mocked(open).mockImplementationOnce(realOpen).mockRejectedValueOnce(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));

      const first = await recordGaps(root, VAULT_ID, [choice()], { now: () => 1 });
      expect(first.map(record => record.id)).toEqual([id]);
      expect(await recorded()).toEqual(["w1", id]);
      expect(await markers()).toHaveLength(0);

      // No marker was written, so the choice is not yet seen and repeats once more; this
      // time the marker write succeeds (no mock left queued).
      const second = await recordGaps(root, VAULT_ID, [choice()], { now: () => 2 });
      expect(second.map(record => record.id)).toEqual([id]);
      expect(await recorded()).toEqual(["w1", id, id]);
      expect(await markers()).toHaveLength(1);

      // The marker written above now covers it, so a third repeat stays closed.
      await recordGaps(root, VAULT_ID, [choice()], { now: () => 3 });
      expect(await recorded()).toEqual(["w1", id, id]);
    });

    it("treats a malformed marker as absent", async () => {
      await recordGaps(root, VAULT_ID, [choice()], { now: () => 1 });
      const [marker] = await markers();
      await writeFile(join(gapsDir(), marker!), "not an offset");
      await recordGaps(root, VAULT_ID, [choice()], { now: () => 2 });
      expect((await readGapLedger(root, VAULT_ID)).events.map(event => event.at)).toEqual([1, 2]);
      await recordGaps(root, VAULT_ID, [choice()], { now: () => 3 });
      expect((await readGapLedger(root, VAULT_ID)).events.map(event => event.at)).toEqual([1, 2]);
    });
  });

  it("refuses a ledger that is not a regular file", async () => {
    await recordGaps(root, VAULT_ID, [gap("a")], { newId: ids("g1") });
    await rm(ledgerPath());
    const elsewhere = join(base, "elsewhere.jsonl");
    await writeFile(elsewhere, "");
    await symlink(elsewhere, ledgerPath());
    await expect(readGapLedger(root, VAULT_ID)).rejects.toThrow();
    await expect(recordGaps(root, VAULT_ID, [gap("b")])).rejects.toThrow();
    expect(await readFile(elsewhere, "utf8")).toBe("");
  });

  it("refuses a draft id that is not a UUID", async () => {
    await expect(writeGapDraft(root, VAULT_ID, "x", { newId: () => "../../escape" })).rejects.toThrow("GAP_DRAFT_ID_INVALID");
  });
});

describe("openGaps", () => {
  it("is a pure fold over the events", () => {
    const record = { type: "gap" as const, id: "g1", at: 1, ...gap("a") };
    const events: GapEvent[] = [record, { type: "resolved", id: "g1", at: 2, reason: "r" }, { ...record, at: 3 }];
    expect(openGaps(events)).toEqual([]);
    expect(openGaps(events.slice(0, 1))).toEqual([{ id: "g1", at: 1, ...gap("a") }]);
    expect(events).toHaveLength(3);
  });
});
