import { appendFile, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existingStateDir } from "../kernel/contract/state-dir.js";
import { readStore, sealContract } from "../kernel/contract/store.js";
import type { PropertyContract, VaultContract } from "../kernel/contract/types.js";
import type { HumanLine, HumanPromptIO } from "../kernel/evolution/human-approval.js";
import { readPolicy, writePolicy } from "../kernel/evolution/policy.js";
import { CANDIDATE_DIR, createRequest, lineageTail, PENDING_DIR, readRequest, type RequestRecord } from "../kernel/evolution/request-state.js";
import { proposeRevert } from "../kernel/evolution/revert.js";
import { readLineage } from "../kernel/contract/lineage.js";
import { serializeVaultSettings } from "../kernel/vault/settings.js";
import { approvePendingCandidates, doctorHuman, setAutonomy, terminalPromptIO } from "./evolution-approve.js";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const NOW = 1_700_000_000_000;
let base: string;
let root: string;
let vault: string;
const saved = { home: process.env.HOME, profile: process.env.USERPROFILE };

const status = (values: string[]): PropertyContract => ({ meaning: "state", type: "text", default: false, required: false, rules: [{ kind: "allowed", values }] });
const PARENT: VaultContract = { folders: { Projects: { meaning: "projects", searchExclude: false } }, properties: { status: status(["a", "b"]) } };
const TIGHTER: VaultContract = { ...PARENT, properties: { status: status(["a"]) } };
const WIDER: VaultContract = { ...PARENT, properties: { status: status(["a", "b", "c"]) } };

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-evo-approve-")));
  root = join(base, "home", ".oms", "vaults");
  vault = join(base, "vault");
  process.env.HOME = join(base, "home");
  process.env.USERPROFILE = join(base, "home");
  await mkdir(join(vault, "Projects"), { recursive: true });
  await mkdir(join(vault, ".oms"), { recursive: true });
  await writeFile(join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: ID, templateFolder: "Templates" }));
  await writeFile(join(vault, "Projects", "ok.md"), "---\nstatus: a\n---\n");
  await sealContract({ vaultRealPath: vault, vaultId: ID, contract: PARENT }, root);
});
afterEach(async () => {
  if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  if (saved.profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.profile;
  await rm(base, { recursive: true, force: true });
});

let counter = 0;
const ids = {
  newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  newToken: () => (++counter).toString(16).padStart(32, "0"),
};

async function issue(contract: VaultContract, after: PropertyContract, at = NOW): Promise<RequestRecord> {
  const { tail } = await lineageTail(root, ID);
  const mutations = [{ op: "MODIFY" as const, axis: "property" as const, key: "status", before: PARENT.properties.status!, after }];
  return createRequest(root, ID, { kind: "evolve", contract, mutations, parent: tail, makerSessionId: "maker-1", state: "awaiting-human" }, { now: () => at, ...ids });
}

/** A terminal that answers each question with the next scripted line and records what it was shown. */
function scripted(answers: readonly string[], extra: Partial<HumanPromptIO> = {}): HumanPromptIO & { readonly shown: string[] } {
  const shown: string[] = [];
  const queue = [...answers];
  return {
    isTTY: true,
    env: {},
    shown,
    write: text => { shown.push(text); },
    readLine: async (): Promise<HumanLine> => {
      const text = queue.shift();
      return text === undefined ? { kind: "eof" } : { kind: "line", text };
    },
    wait: () => new Promise<void>(() => undefined),
    ...extra,
  };
}

const storeDigest = async (): Promise<string | null> => {
  const store = await readStore(ID, root);
  return store.state === "ok" ? store.digest : null;
};

const never = new AbortController().signal;

describe("terminalPromptIO", () => {
  it("reads one line at a time from the input and writes to the output", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const shown: string[] = [];
    output.on("data", chunk => shown.push(String(chunk)));
    const terminal = terminalPromptIO(input, output, { OMS_NON_INTERACTIVE: "1" });
    expect(terminal.io.isTTY).toBeUndefined();
    expect(terminal.io.env).toEqual({ OMS_NON_INTERACTIVE: "1" });
    terminal.io.write("question? ");
    const first = terminal.io.readLine(never);
    input.write("approve\n");
    expect(await first).toEqual({ kind: "line", text: "approve" });
    const second = terminal.io.readLine(never);
    input.write("no\n");
    expect(await second).toEqual({ kind: "line", text: "no" });
    expect(shown.join("")).toContain("question? ");
    terminal.close();
  });

  it("reports eof when the input ends, and again on every later read", async () => {
    const input = new PassThrough();
    const terminal = terminalPromptIO(input, new PassThrough(), {});
    const read = terminal.io.readLine(never);
    input.end();
    expect(await read).toEqual({ kind: "eof" });
    expect(await terminal.io.readLine(never)).toEqual({ kind: "eof" });
    terminal.close();
  });

  it("reports an interrupt on Ctrl-C at a terminal and on an aborted read", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    const terminal = terminalPromptIO(input, output, {});
    const interrupted = terminal.io.readLine(never);
    input.write("\x03");
    expect(await interrupted).toEqual({ kind: "interrupted" });
    const stop = new AbortController();
    const aborted = terminal.io.readLine(stop.signal);
    stop.abort();
    expect(await aborted).toEqual({ kind: "interrupted" });
    terminal.close();
    terminal.close();
  });

  it("waits the given time, and never resolves once aborted", async () => {
    const terminal = terminalPromptIO(new PassThrough(), new PassThrough(), {});
    await terminal.io.wait(1, never);
    const stop = new AbortController();
    let done = false;
    void terminal.io.wait(5, stop.signal).then(() => { done = true; });
    stop.abort();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(done).toBe(false);
    terminal.close();
  });

  it("closes without opening a reader when nothing was read", () => {
    const input = new PassThrough();
    const terminal = terminalPromptIO(input, new PassThrough(), {});
    terminal.close();
    expect(input.listenerCount("data")).toBe(0);
  });
});

describe("doctorHuman", () => {
  it("asks the owner about the subject and returns the decision", async () => {
    const io = scripted(["yes"]);
    const human = doctorHuman(io);
    expect(human.interactive).toBe(true);
    expect(await human.confirm({ op: "reclaim-evolution-lock" })).toBe("approve");
    expect(io.shown.join("")).toContain("Confirm this owner-only repair:\n{\n  \"op\": \"reclaim-evolution-lock\"\n}");
    expect(await human.confirm({ op: "x" })).toBe("reject");
  });

  it("is not interactive off a terminal and rejects without asking", async () => {
    const io = scripted(["yes"], { isTTY: false });
    const human = doctorHuman(io);
    expect(human.interactive).toBe(false);
    expect(await human.confirm({ op: "x" })).toBe("reject");
    expect(io.shown).toEqual([]);
  });
});

describe("approvePendingCandidates", () => {
  const run = (io: HumanPromptIO, extra: { vault?: string; beforeSeal?: () => Promise<void> } = {}) =>
    approvePendingCandidates({ vault: extra.vault ?? vault, root, io, now: () => NOW, deps: extra.beforeSeal ? { beforeSeal: extra.beforeSeal } : {} });

  it("does nothing without an interactive terminal", async () => {
    await issue(WIDER, WIDER.properties.status!);
    const io = scripted(["approve"], { env: { OMS_NON_INTERACTIVE: "1" } });
    expect(await run(io)).toEqual([]);
    expect(io.shown).toEqual([]);
  });

  it("does nothing for a vault with no sealed contract", async () => {
    const bare = join(base, "bare");
    await mkdir(bare, { recursive: true });
    expect(await run(scripted(["approve"]), { vault: bare })).toEqual([]);
  });

  it("shows the loosening items and seals the candidate the owner approves", async () => {
    const request = await issue(WIDER, WIDER.properties.status!);
    const io = scripted(["approve"]);
    expect(await run(io)).toEqual([{ requestId: request.requestId, decision: "approve", outcome: "sealed" }]);
    const shown = io.shown.join("");
    expect(shown).toContain(`Pending contract change ${request.requestId} (loosening).`);
    expect(shown).toContain("  LOOSENING MODIFY property status: ");
    expect(shown).toContain("Items marked LOOSENING let notes through that the sealed contract refuses today.");
    expect(await storeDigest()).toBe(request.candidateDigest);
  });

  it("shows a tightening candidate without loosening marks and records a reject", async () => {
    const before = await storeDigest();
    const request = await issue(TIGHTER, TIGHTER.properties.status!);
    const io = scripted(["no"]);
    expect(await run(io)).toEqual([{ requestId: request.requestId, decision: "reject", reason: "explicit", state: "rejected" }]);
    const shown = io.shown.join("");
    expect(shown).toContain("(tightening)");
    expect(shown).toContain("  MODIFY property status: ");
    expect(shown).not.toContain("LOOSENING");
    expect(await storeDigest()).toBe(before);
    expect((await readRequest(root, ID, request.requestId))?.state).toBe("rejected");
  });

  it("reports an evolution refusal per candidate and keeps going", async () => {
    const tampered = await issue(WIDER, WIDER.properties.status!);
    const candidate = join((await existingStateDir(root, ID, "evolution"))!, PENDING_DIR, tampered.requestId, CANDIDATE_DIR);
    const file = (await readdir(candidate, { recursive: true, withFileTypes: true })).find(entry => entry.isFile())!;
    await appendFile(join(file.parentPath, file.name), " ");
    const results = await run(scripted(["approve"]));
    expect(results).toEqual([{ requestId: tampered.requestId, error: expect.stringMatching(/^EVOLUTION_CANDIDATE_MISMATCH:/) }]);
  });

  for (const autonomous of [false, true]) {
    it(`lists a tightening and a neutral revert for the owner and seals each on approve, policy ${autonomous ? "on" : "off"}`, async () => {
      if (autonomous) await writePolicy(root, ID, { version: 1, autonomous: true, limits: { perDay: 1, perWeek: 3 } }, { interactive: true });
      const deps = { now: () => NOW, ...ids };
      const target = (await readStore(ID, root) as { digest: string }).digest;
      await sealContract({ vaultRealPath: vault, vaultId: ID, contract: WIDER }, root);
      const tightening = await proposeRevert({ root, vaultId: ID, vaultRealPath: vault, targetDigest: target }, deps);
      expect(tightening).toMatchObject({ direction: "tightening", state: "awaiting-human" });
      const first = scripted(["approve"]);
      expect(await run(first)).toEqual([{ requestId: tightening.requestId, decision: "approve", outcome: "sealed" }]);
      expect(first.shown.join("")).toContain(`Pending contract revert ${tightening.requestId} (tightening).`);
      expect(first.shown.join("")).toContain(`  reverts to ${target}`);
      expect(await storeDigest()).toBe(target);

      const declined = (await sealContract({ vaultRealPath: vault, vaultId: ID, contract: PARENT, declined: { folders: ["Archive"], properties: [] } }, root)).digest;
      await sealContract({ vaultRealPath: vault, vaultId: ID, contract: PARENT }, root);
      const neutral = await proposeRevert({ root, vaultId: ID, vaultRealPath: vault, targetDigest: declined }, deps);
      expect(neutral).toMatchObject({ direction: "neutral", state: "awaiting-human" });
      const second = scripted(["approve"]);
      expect(await run(second)).toEqual([{ requestId: neutral.requestId, decision: "approve", outcome: "sealed" }]);
      expect(second.shown.join("")).toContain(`Pending contract revert ${neutral.requestId} (neutral).`);
      expect(await storeDigest()).toBe(declined);
      const sealed = (await readLineage(root, ID, "display")).events.filter(event => event.revertOf !== undefined);
      expect(sealed).toMatchObject([
        { digest: target, proposer: "owner", mode: "human", autonomous: false },
        { digest: declined, proposer: "owner", mode: "human", autonomous: false },
      ]);
    });
  }

  it("rethrows a failure that is not a contract or evolution refusal", async () => {
    await issue(WIDER, WIDER.properties.status!);
    await expect(run(scripted(["approve"]), { beforeSeal: async () => { throw new Error("disk on fire"); } })).rejects.toThrow("disk on fire");
  });
});

describe("setAutonomy", () => {
  it("turns autonomy on after the owner approves, keeping the limits", async () => {
    const io = scripted(["approve"]);
    const result = await setAutonomy({ vault, root, io, enable: true });
    expect(result).toEqual({ status: "updated", policy: { version: 1, autonomous: true, limits: { perDay: 1, perWeek: 3 } } });
    expect(io.shown.join("")).toContain("Turn on autonomous contract evolution for this vault?");
    expect(io.shown.join("")).toContain("At most 1 seal(s) per 24 hours and 3 per 7 days");
    expect((await readPolicy(root, ID)).policy.autonomous).toBe(true);
  });

  it("keeps autonomy off when the owner rejects", async () => {
    const result = await setAutonomy({ vault, root, io: scripted(["reject"]), enable: true });
    expect(result).toEqual({ status: "unchanged", reason: "explicit", policy: { version: 1, autonomous: false, limits: { perDay: 1, perWeek: 3 } } });
    expect((await readPolicy(root, ID)).policy.autonomous).toBe(false);
  });

  it("refuses to turn autonomy on off a terminal", async () => {
    await expect(setAutonomy({ vault, root, io: scripted(["approve"], { isTTY: false }), enable: true })).rejects.toThrow(/^EVOLUTION_POLICY_REQUIRES_TTY:/);
    expect((await readPolicy(root, ID)).policy.autonomous).toBe(false);
  });

  it("turns autonomy off without asking, even off a terminal", async () => {
    await writePolicy(root, ID, { version: 1, autonomous: true, limits: { perDay: 1, perWeek: 2 } }, { interactive: true });
    const io = scripted([], { isTTY: false });
    const result = await setAutonomy({ vault, root, io, enable: false });
    expect(result).toEqual({ status: "updated", policy: { version: 1, autonomous: false, limits: { perDay: 1, perWeek: 2 } } });
    expect(io.shown).toEqual([]);
  });

  it("refuses a vault with no sealed contract", async () => {
    const bare = join(base, "bare");
    await mkdir(bare, { recursive: true });
    await expect(setAutonomy({ vault: bare, root, io: scripted([]), enable: false })).rejects.toThrow(/^EVOLUTION_NO_CONTRACT:/);
  });
});
