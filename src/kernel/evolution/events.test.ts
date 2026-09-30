import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvolutionEvent, EVOLUTION_EVENT_KINDS, evolutionCounters, readEvolutionEvents, type EvolutionEvent } from "./events.js";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
let base: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-evo-events-")));
  root = join(base, "home", ".oms", "vaults");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const journal = (): string => join(root, `.${ID}.state`, "evolution", "events.jsonl");

describe("evolution events", () => {
  it("reads an absent journal as empty without creating it", async () => {
    expect(await readEvolutionEvents(root, ID)).toEqual({ events: [], skipped: [] });
    expect((await evolutionCounters(root, ID))["seal.autonomous"]).toBe(0);
    await expect(readFile(journal())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("appends one line per event and counts them by kind", async () => {
    await appendEvolutionEvent(root, ID, { kind: "request.issued", at: 1, requestId: "r1" });
    await appendEvolutionEvent(root, ID, { kind: "verdict.received", at: 2, requestId: "r1", detail: { accepted: true } });
    await appendEvolutionEvent(root, ID, { kind: "verdict.received", at: 3, requestId: "r1" });
    const read = await readEvolutionEvents(root, ID);
    expect(read.events.map(event => event.kind)).toEqual(["request.issued", "verdict.received", "verdict.received"]);
    expect(read.events[1]!.detail).toEqual({ accepted: true });
    const counters = await evolutionCounters(root, ID);
    expect(counters["verdict.received"]).toBe(2);
    expect(Object.keys(counters)).toEqual([...EVOLUTION_EVENT_KINDS]);
  });

  it("refuses an unknown kind before writing anything", async () => {
    await expect(appendEvolutionEvent(root, ID, { kind: "seal.whatever", at: 1 } as unknown as EvolutionEvent)).rejects.toThrow(/EVOLUTION_EVENT_INVALID/);
    await expect(readFile(journal())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips lines that do not parse as events", async () => {
    await appendEvolutionEvent(root, ID, { kind: "lock.reclaimed", at: 1 });
    await appendFile(journal(), "{broken\n[1]\n{\"kind\":\"nope\",\"at\":1}\n{\"kind\":\"lock.reclaimed\"}\n{\"kind\":\"lock.reclaimed\",\"at\":2,\"requestId\":7}\n\n");
    await appendEvolutionEvent(root, ID, { kind: "lock.reclaimed", at: 3 });
    const read = await readEvolutionEvents(root, ID);
    expect(read.events.map(event => event.at)).toEqual([1, 3]);
    expect(read.skipped).toEqual([2, 3, 4, 5, 6]);
  });

  it("refuses a journal replaced by a symlink", async () => {
    await mkdir(join(root, `.${ID}.state`, "evolution"), { recursive: true, mode: 0o700 });
    await writeFile(join(base, "elsewhere"), "");
    await symlink(join(base, "elsewhere"), journal());
    await expect(appendEvolutionEvent(root, ID, { kind: "lock.reclaimed", at: 1 })).rejects.toMatchObject({ code: "STATE_DIR_UNSAFE" });
    await expect(readEvolutionEvents(root, ID)).rejects.toMatchObject({ code: "STATE_DIR_UNSAFE" });
  });

  it("refuses a journal larger than the read bound", async () => {
    await appendEvolutionEvent(root, ID, { kind: "lock.reclaimed", at: 1 });
    await appendFile(journal(), Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    await expect(readEvolutionEvents(root, ID)).rejects.toThrow(/EVOLUTION_EVENTS_TOO_LARGE/);
  });
});
