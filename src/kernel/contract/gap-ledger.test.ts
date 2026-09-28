import { appendFile, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GAP_EVENTS_FILE, openGaps, readGapDraft, readGapLedger, recordGaps, resolveGap, writeGapDraft,
  type GapEvent, type GapInput,
} from "./gap-ledger.js";
import { stateDir } from "./state-dir.js";

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

  it("refuses a ledger that is too large or not a regular file", async () => {
    await recordGaps(root, VAULT_ID, [gap("a")], { newId: ids("g1") });
    await truncate(ledgerPath(), 16 * 1024 * 1024 + 1);
    await expect(readGapLedger(root, VAULT_ID)).rejects.toThrow("GAP_LEDGER_TOO_LARGE");
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
