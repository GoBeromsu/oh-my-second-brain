import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendInterviewEvent, EVENTS_FILE, migrateInterviewLog, pendingLogKey, questionDigest, readInterviewLog } from "./interview-log.js";
import { stateDir } from "./state-dir.js";

const VAULT_ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";

let base: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-interview-log-")));
  root = join(base, "home", ".oms", "vaults");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const logPath = (): string => join(stateDir(root, VAULT_ID), "interview", EVENTS_FILE);

function answered(questionId: string, answer: string) {
  return { type: "answered" as const, questionId, questionDigest: `digest-${questionId}`, payload: { answer } };
}

describe("interview event log", () => {
  it("reads an absent log as empty and creates nothing", async () => {
    expect(await readInterviewLog(root, VAULT_ID)).toEqual({ events: [], corrupt: [] });
    await expect(readFile(logPath())).rejects.toThrow();
  });

  it("appends in order with increasing sequence numbers and the injected clock", async () => {
    let tick = 1000;
    const now = (): number => tick++;
    await appendInterviewEvent(root, VAULT_ID, answered("a", "1"), now);
    await appendInterviewEvent(root, VAULT_ID, answered("b", "2"), now);
    await appendInterviewEvent(root, VAULT_ID, { type: "proposed", questionId: null, questionDigest: null, payload: { digest: "d" } }, now);
    const { events, corrupt } = await readInterviewLog(root, VAULT_ID);
    expect(corrupt).toEqual([]);
    expect(events.map(event => [event.seq, event.at, event.type, event.questionId])).toEqual([
      [1, 1000, "answered", "a"],
      [2, 1001, "answered", "b"],
      [3, 1002, "proposed", null],
    ]);
    const text = await readFile(logPath(), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.split("\n").filter(line => line !== "")).toHaveLength(3);
  });

  it("gives concurrent appends distinct sequence numbers and loses none", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => appendInterviewEvent(root, VAULT_ID, answered(`q${index}`, String(index)))));
    const { events, corrupt } = await readInterviewLog(root, VAULT_ID);
    expect(corrupt).toEqual([]);
    expect(events.map(event => event.seq)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(new Set(events.map(event => event.questionId)).size).toBe(20);
  });

  it("skips and reports a truncated line, keeps its bytes, and appends on a fresh line", async () => {
    await appendInterviewEvent(root, VAULT_ID, answered("a", "1"));
    const cut = '{"seq":2,"at":5,"type":"answ';
    await appendFile(logPath(), cut);
    const before = await readInterviewLog(root, VAULT_ID);
    expect(before.events.map(event => event.seq)).toEqual([1]);
    expect(before.corrupt).toEqual([2]);

    const written = await appendInterviewEvent(root, VAULT_ID, answered("b", "2"));
    expect(written.seq).toBe(2);
    const after = await readInterviewLog(root, VAULT_ID);
    expect(after.events.map(event => event.questionId)).toEqual(["a", "b"]);
    expect(after.corrupt).toEqual([2]);
    expect(await readFile(logPath(), "utf8")).toContain(`${cut}\n`);
  });

  it("reports a line that parses but is not an event", async () => {
    await appendInterviewEvent(root, VAULT_ID, answered("a", "1"));
    await appendFile(logPath(), '{"seq":0,"at":1,"type":"answered","questionId":"x","questionDigest":null,"payload":{}}\n{"seq":3,"at":1,"type":"bogus","questionId":null,"questionDigest":null,"payload":{}}\n');
    const { events, corrupt } = await readInterviewLog(root, VAULT_ID);
    expect(events).toHaveLength(1);
    expect(corrupt).toEqual([2, 3]);
  });

  it("digests a question by what it asks", () => {
    const text = { id: "q", prompt: "What?", kind: "text" as const };
    expect(questionDigest(text)).toBe(questionDigest({ ...text }));
    expect(questionDigest(text)).not.toBe(questionDigest({ ...text, prompt: "What now?" }));
    const choice = { id: "q", prompt: "Pick", kind: "choice" as const, options: ["a"] };
    expect(questionDigest(choice)).not.toBe(questionDigest({ ...choice, options: ["b"] }));
  });
});

describe("pending interview log", () => {
  const PENDING = `pending-${"b".repeat(64)}`;

  it("keys a vault without an id by the digest of its real path, the same through a symlink", async () => {
    const vault = join(base, "vault");
    await mkdir(vault);
    await symlink(vault, join(base, "alias"));
    const key = await pendingLogKey(vault);
    expect(key).toMatch(/^pending-[0-9a-f]{64}$/);
    expect(await pendingLogKey(vault)).toBe(key);
    expect(await pendingLogKey(join(base, "alias"))).toBe(key);
    expect(await pendingLogKey(join(base, "other"))).not.toBe(key);
  });

  it("moves a pending log to the vault id when the id has no log yet", async () => {
    await appendInterviewEvent(root, PENDING, answered("a", "1"), () => 1);
    await appendFile(join(stateDir(root, PENDING), "interview", EVENTS_FILE), "garbage\n");
    await migrateInterviewLog(root, PENDING, VAULT_ID);
    const moved = await readInterviewLog(root, VAULT_ID);
    expect(moved.events.map(event => event.questionId)).toEqual(["a"]);
    expect(moved.corrupt).toHaveLength(1);
    expect(await readInterviewLog(root, PENDING)).toEqual({ events: [], corrupt: [] });
    await expect(stat(stateDir(root, PENDING))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("appends a pending log after the events the vault id already has, keeping their times", async () => {
    await appendInterviewEvent(root, VAULT_ID, answered("old", "0"), () => 1);
    await appendInterviewEvent(root, PENDING, answered("a", "1"), () => 2);
    await appendInterviewEvent(root, PENDING, answered("b", "2"), () => 3);
    await migrateInterviewLog(root, PENDING, VAULT_ID);
    const { events } = await readInterviewLog(root, VAULT_ID);
    expect(events.map(event => event.questionId)).toEqual(["old", "a", "b"]);
    expect(events.map(event => event.seq)).toEqual([1, 2, 3]);
    expect(events.map(event => event.at)).toEqual([1, 2, 3]);
    expect(await readInterviewLog(root, PENDING)).toEqual({ events: [], corrupt: [] });
  });

  it("does nothing when there is no pending log", async () => {
    await migrateInterviewLog(root, PENDING, VAULT_ID);
    expect(await readInterviewLog(root, VAULT_ID)).toEqual({ events: [], corrupt: [] });
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
