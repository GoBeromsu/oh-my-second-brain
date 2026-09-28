import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeVaultSettings, SETTINGS_PATH } from "../vault/settings.js";
import { runInterview } from "./interview.js";
import { appendInterviewEvent, EVENTS_FILE, readInterviewLog } from "./interview-log.js";
import { resumableIO } from "./interview-resume.js";
import { scriptedIO } from "./scripted-interview.js";
import { ensureStateDir, existingStateDir, stateDir, StateDirUnsafe } from "./state-dir.js";
import { readStore, sealContract, storeHousekeeping } from "./store.js";

const VAULT_ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const NOW = 1_800_000_000_000;

let base: string;
let vault: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-state-dir-")));
  vault = join(base, "vault");
  root = join(base, "home", ".oms", "vaults");
  await mkdir(join(vault, "Projects"), { recursive: true });
  await mkdir(join(vault, ".oms"));
  await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: VAULT_ID }));
  await writeFile(join(vault, "Projects/Alpha.md"), "---\nstatus: active\n---\nbody\n");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const eventsPath = (storeRoot = root): string => join(stateDir(storeRoot, VAULT_ID), "interview", EVENTS_FILE);
const answered = (questionId: string) => ({ type: "answered" as const, questionId, questionDigest: "d", payload: { answer: "yes" } });

async function sealByInterview(): Promise<void> {
  const { io } = scriptedIO({
    "template-folder:path": "",
    "folder:Projects:register": true,
    "folder:Projects:meaning": "project notes",
    "folder:Projects:search-exclude": false,
    seal: true,
  });
  const resumed = await resumableIO({ vault, root, fallback: io, now: () => NOW });
  const result = await runInterview({ vault, io: resumed.io, root, sealDeps: { now: () => NOW } });
  expect(result.state === "incomplete" ? result.questions.map(question => question.id) : result.state).toBe("sealed");
}

async function logFingerprint(): Promise<{ readonly lines: number; readonly sha256: string }> {
  const bytes = await readFile(eventsPath());
  return { lines: bytes.toString("utf8").split("\n").filter(line => line !== "").length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function generationDirs(): Promise<string[]> {
  return (await readdir(root)).filter(entry => new RegExp(`^\\.${VAULT_ID}\\.\\d+$`).test(entry));
}

async function expectUnsafe(promise: Promise<unknown>, kind: string): Promise<void> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(StateDirUnsafe);
  expect((error as StateDirUnsafe).code).toBe("STATE_DIR_UNSAFE");
  expect((error as StateDirUnsafe).kind).toBe(kind);
}

describe("interview state beside the contract store", () => {
  it("leaves the store readable and the log intact across seals", async () => {
    await appendInterviewEvent(root, VAULT_ID, answered("before"), () => NOW);
    expect((await readStore(VAULT_ID, root)).state).toBe("absent");

    await sealByInterview();
    const first = await readStore(VAULT_ID, root);
    if (first.state !== "ok") throw new Error(first.state);
    const logged = await logFingerprint();
    const housekeeping = await storeHousekeeping(VAULT_ID, root);

    for (let seal = 0; seal < 2; seal += 1) {
      await sealContract({ vaultRealPath: vault, vaultId: VAULT_ID, contract: first.contract }, root, { now: () => NOW });
    }
    expect((await readStore(VAULT_ID, root)).state).toBe("ok");
    expect(await logFingerprint()).toEqual(logged);
    expect(await storeHousekeeping(VAULT_ID, root)).toEqual(housekeeping);
    expect(housekeeping).toEqual({ staleLocks: 0, orphans: 0 });

    const generations = await generationDirs();
    expect(generations.length).toBeGreaterThan(0);
    for (const generation of generations) {
      const names = await readdir(join(root, generation), { recursive: true });
      expect(names.filter(name => /\.state|events\.jsonl|interview|evolution/.test(name))).toEqual([]);
    }
    expect((await lstat(stateDir(root, VAULT_ID))).isDirectory()).toBe(true);
  });

  it("survives losing the contract link, and the next seal starts at sequence 1", async () => {
    await sealByInterview();
    const logged = await logFingerprint();
    await rm(join(root, VAULT_ID));
    for (const generation of await generationDirs()) await rm(join(root, generation), { recursive: true });
    expect((await readStore(VAULT_ID, root)).state).toBe("absent");
    expect(await logFingerprint()).toEqual(logged);

    await sealByInterview();
    expect(await readlink(join(root, VAULT_ID))).toBe(`.${VAULT_ID}.1`);
    const events = (await readInterviewLog(root, VAULT_ID)).events;
    expect(events.filter(event => event.type === "sealed")).toHaveLength(2);
  });

  it("creates directories 0700 and the log 0600", async () => {
    if (process.platform === "win32") return;
    await appendInterviewEvent(root, VAULT_ID, answered("q"));
    expect((await stat(stateDir(root, VAULT_ID))).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateDir(root, VAULT_ID), "interview"))).mode & 0o777).toBe(0o700);
    expect((await stat(eventsPath())).mode & 0o777).toBe(0o600);
    expect(await ensureStateDir(root, VAULT_ID, "evolution")).toBe(join(stateDir(root, VAULT_ID), "evolution"));
  });

  it("finds nothing and creates nothing when the state directory is absent", async () => {
    expect(await existingStateDir(root, VAULT_ID)).toBeNull();
    await expect(readdir(root)).rejects.toThrow();
  });

  it("refuses a symlinked state directory and leaves its target alone", async () => {
    const elsewhere = join(base, "elsewhere");
    await mkdir(join(elsewhere, "interview"), { recursive: true, mode: 0o700 });
    await mkdir(root, { recursive: true, mode: 0o700 });
    await symlink(elsewhere, stateDir(root, VAULT_ID));
    await expectUnsafe(appendInterviewEvent(root, VAULT_ID, answered("q")), "symlink");
    await expectUnsafe(readInterviewLog(root, VAULT_ID), "symlink");
    expect(await readdir(join(elsewhere, "interview"))).toEqual([]);
    expect(await readlink(stateDir(root, VAULT_ID))).toBe(elsewhere);
  });

  it("refuses a symlinked log and leaves its target unchanged", async () => {
    const target = join(base, "target.jsonl");
    await writeFile(target, "keep\n");
    await ensureStateDir(root, VAULT_ID);
    await symlink(target, eventsPath());
    await expectUnsafe(appendInterviewEvent(root, VAULT_ID, answered("q")), "symlink");
    await expectUnsafe(readInterviewLog(root, VAULT_ID), "symlink");
    expect(await readFile(target, "utf8")).toBe("keep\n");
  });

  it("refuses a FIFO log without blocking on it", async () => {
    if (process.platform === "win32") return;
    await ensureStateDir(root, VAULT_ID);
    execFileSync("mkfifo", [eventsPath()]);
    await expectUnsafe(appendInterviewEvent(root, VAULT_ID, answered("q")), "fifo");
    await expectUnsafe(readInterviewLog(root, VAULT_ID), "fifo");
    expect((await lstat(eventsPath())).isFIFO()).toBe(true);
  }, 2000);

  it("refuses a socket in place of the log", async () => {
    if (process.platform === "win32") return;
    // Socket paths are limited to ~104 bytes, so this store root sits directly under /tmp.
    const short = await realpath(await mkdtemp("/tmp/oms-sock-"));
    const socketRoot = join(short, "r");
    let server: Server | undefined;
    try {
      await ensureStateDir(socketRoot, VAULT_ID);
      server = createServer();
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(eventsPath(socketRoot), resolve);
      });
      await expectUnsafe(appendInterviewEvent(socketRoot, VAULT_ID, answered("q")), "socket");
      await expectUnsafe(readInterviewLog(socketRoot, VAULT_ID), "socket");
    } finally {
      await new Promise<void>(resolve => server === undefined ? resolve() : server.close(() => resolve()));
      await rm(short, { recursive: true, force: true });
    }
  }, 2000);

  it("refuses a state directory that is a file", async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(stateDir(root, VAULT_ID), "not a directory");
    await expectUnsafe(appendInterviewEvent(root, VAULT_ID, answered("q")), "file");
    expect(await readFile(stateDir(root, VAULT_ID), "utf8")).toBe("not a directory");
  });

  it("rejects a vault id that is not a UUID", () => {
    expect(() => stateDir(root, "../escape")).toThrow("CONTRACT_VAULT_ID_INVALID");
  });

  it("accepts a pending key for a vault not sealed yet", () => {
    const key = `pending-${"a".repeat(64)}`;
    expect(stateDir(root, key)).toBe(join(root, `.${key}.state`));
    expect(() => stateDir(root, "pending-xyz")).toThrow("CONTRACT_VAULT_ID_INVALID");
  });

  it("refuses an entry owned by another user and names the fix", async () => {
    if (process.platform === "win32") return;
    await ensureStateDir(root, VAULT_ID);
    const other = process.getuid!() + 1;
    const error = await ensureStateDir(root, VAULT_ID, "interview", { uid: other }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StateDirUnsafe);
    expect((error as StateDirUnsafe).kind).toBe("foreign-owner");
    expect((error as StateDirUnsafe).message).toContain("chown");
    expect(await existingStateDir(root, VAULT_ID, "interview", { uid: other }).catch((caught: unknown) => (caught as StateDirUnsafe).kind)).toBe("foreign-owner");
  });

  it("refuses a group- or other-writable entry and names the chmod that fixes it", async () => {
    if (process.platform === "win32") return;
    await ensureStateDir(root, VAULT_ID);
    const shared = stateDir(root, VAULT_ID);
    await chmod(shared, 0o722);
    const error = await appendInterviewEvent(root, VAULT_ID, answered("q")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StateDirUnsafe);
    expect((error as StateDirUnsafe).kind).toBe("shared-writable");
    expect((error as StateDirUnsafe).message).toContain(`chmod go-w ${shared}`);
    expect((await stat(shared)).mode & 0o777).toBe(0o722);
  });

  it("refuses a symlink in a parent component of the state directory", async () => {
    if (process.platform === "win32") return;
    const real = join(base, "elsewhere");
    await mkdir(real, { recursive: true, mode: 0o700 });
    await mkdir(root, { recursive: true, mode: 0o700 });
    await symlink(real, stateDir(root, VAULT_ID));
    await expectUnsafe(ensureStateDir(root, VAULT_ID), "symlink");
    expect(await readdir(real)).toEqual([]);
  });

  it("re-checks a directory right after creating it and refuses one swapped for a symlink", async () => {
    if (process.platform === "win32") return;
    const decoy = join(base, "decoy");
    await mkdir(decoy, { mode: 0o755 });
    const afterCreate = async (path: string): Promise<void> => {
      if (path !== stateDir(root, VAULT_ID)) return;
      await rm(path, { recursive: true });
      await symlink(decoy, path);
    };
    await expectUnsafe(ensureStateDir(root, VAULT_ID, "interview", { afterCreate }), "symlink");
    expect((await stat(decoy)).mode & 0o777).toBe(0o755);
    expect(await readdir(decoy)).toEqual([]);
  });
});
