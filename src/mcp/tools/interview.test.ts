import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTruthTableRow, type TruthTableFixture } from "../../../test/fixtures/contract-truth-table.js";
import { pendingLogKey, readInterviewLog } from "../../kernel/contract/interview-log.js";
import { stateDir } from "../../kernel/contract/state-dir.js";
import { currentSequence, readStore, SEAL_LOCK_STALE_MS } from "../../kernel/contract/store.js";
import { ensureVaultId, resolveSealState } from "../../kernel/contract/vault-id.js";
import { readVaultSettings } from "../../kernel/vault/settings.js";
import { omsMcpTools } from "../server.js";
import { handleInterview, type InterviewToolDeps } from "./interview.js";
import type { ToolContext } from "./shared.js";

const fixtures: TruthTableFixture[] = [];
const scratch: string[] = [];
let savedEnv: Record<string, string | undefined>;

/** Every entry with its content digest (or link target), so any write shows. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isSymbolicLink()) out.set(rel, `<link>${await readlink(full)}`);
      else if (entry.isDirectory()) {
        out.set(`${rel}/`, "<dir>");
        await walk(full);
      } else out.set(rel, createHash("sha256").update(await readFile(full)).digest("hex"));
    }
  };
  await walk(root);
  return out;
}

/** handleInterview reads only the verified vault from its context. */
function context(vault: string): ToolContext {
  return { vault, source: "explicit" } as unknown as ToolContext;
}

function payload(result: Awaited<ReturnType<typeof handleInterview>>): Record<string, unknown> {
  const first = result.content[0];
  return JSON.parse(first?.type === "text" ? first.text : "{}") as Record<string, unknown>;
}

/** A vault inferred from the working directory: never a write target. */
function cwdContext(vault: string): ToolContext {
  return { vault, source: "cwd" } as unknown as ToolContext;
}

function useHome(home: string): void {
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
}

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OMS_") || key.startsWith("XDG_")) delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("MCP interview", () => {
  it("lists questions for an unsealed vault and seals nothing", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "oms-mcp-interview-")));
    scratch.push(base);
    const vault = path.join(base, "vault");
    const home = path.join(base, "home");
    await mkdir(path.join(vault, "Projects"), { recursive: true });
    await mkdir(home);
    useHome(home);
    const before = await snapshot(base);

    const result = await handleInterview(context(vault), {});
    const body = payload(result);
    expect(result.isError).not.toBe(true);
    expect(body["status"]).toBe("questions");
    expect(Array.isArray(body["questions"]) && body["questions"].length).toBeGreaterThan(0);
    expect(String(body["next"])).toContain("op \"answer\"");
    expect(await snapshot(base)).toEqual(before);
  });

  it("leaves a sealed contract and its store unchanged, with or without reask", async () => {
    const fixture = await buildTruthTableRow("sealed");
    fixtures.push(fixture);
    useHome(path.join(fixture.base, "home"));
    const before = await snapshot(fixture.base);

    for (const args of [{}, { reask: true }]) {
      const body = payload(await handleInterview(context(fixture.vault), args));
      expect(body["contract"]).toMatchObject({ contract: "sealed", row: "sealed" });
      expect(["questions", "proposed", "refused"]).toContain(body["status"]);
    }
    expect(await snapshot(fixture.base)).toEqual(before);
  });

  it("accepts the interview ops and nothing else", () => {
    const tool = omsMcpTools.find((candidate) => candidate.name === "interview");
    const validate = new AjvJsonSchemaValidator().getValidator(tool!.inputSchema);
    expect(validate({}).valid).toBe(true);
    expect(validate({ reask: true }).valid).toBe(true);
    for (const op of ["questions", "answer", "confirm", "seal"]) expect(validate({ op }).valid).toBe(true);
    expect(validate({ op: "reclaim" }).valid).toBe(false);
    expect(validate({ op: "seal", confirmStaleReclaim: true }).valid).toBe(false);
    expect(tool!.annotations?.readOnlyHint).not.toBe(true);
  });
});

/** A fresh vault without templates, its HOME and store root, all under one tmp dir. */
async function freshVault(): Promise<{ base: string; vault: string; root: string }> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "oms-mcp-interview-seal-")));
  scratch.push(base);
  const vault = path.join(base, "vault");
  const home = path.join(base, "home");
  await mkdir(path.join(vault, "Projects"), { recursive: true });
  await writeFile(path.join(vault, "Projects", "Alpha.md"), "---\nstatus: active\n---\n# Alpha\n");
  await mkdir(home);
  useHome(home);
  return { base, vault, root: path.join(home, ".oms", "vaults") };
}

function defaultAnswer(question: Record<string, unknown>): string | number | boolean {
  const fallback = question["default"];
  if (typeof fallback === "string" || typeof fallback === "number" || typeof fallback === "boolean") return fallback;
  const choices = question["choices"];
  if (Array.isArray(choices) && typeof choices[0] === "string") return choices[0];
  return question["kind"] === "confirm" ? true : "";
}

/** Answers every open question with its default, one call per round, until a proposal comes back. */
async function answerAll(vault: string, deps: InterviewToolDeps, chosen: Readonly<Record<string, string | number | boolean>> = {}): Promise<string> {
  for (let round = 0; round < 10; round += 1) {
    const body = payload(await handleInterview(context(vault), {}, deps));
    if (body["status"] === "proposed") return String(body["proposed"]);
    expect(body["status"]).toBe("questions");
    const answers = Object.fromEntries((body["questions"] as Record<string, unknown>[]).map(question => {
      const id = String(question["id"]);
      return [id, Object.hasOwn(chosen, id) ? chosen[id]! : defaultAnswer(question)];
    }));
    const answered = payload(await handleInterview(context(vault), { op: "answer", answers }, deps));
    if (answered["status"] === "proposed") return String(answered["proposed"]);
  }
  throw new Error("the interview never proposed a contract");
}

describe("MCP interview seal", () => {
  const clock = (): InterviewToolDeps => ({ now: () => 1_750_000_000_000 });

  it("records answers, then seals only after a confirm citing the latest proposal", async () => {
    const { vault, root } = await freshVault();
    const deps = { ...clock(), root };
    const proposed = await answerAll(vault, deps);
    expect(proposed).toMatch(/^[0-9a-f]{64}$|^sha256:/);

    const early = payload(await handleInterview(context(vault), { op: "seal" }, deps));
    expect(early).toMatchObject({ ok: false, status: "rejected", rejection: { code: "INTERVIEW_CONFIRM_REQUIRED" } });

    const confirmed = payload(await handleInterview(context(vault), { op: "confirm", proposed }, deps));
    expect(confirmed).toMatchObject({ ok: true, status: "confirmed", proposed });
    // Nothing inside the vault is written before the seal: the log is keyed by the pending key.
    await expect(stat(path.join(vault, ".oms", "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readVaultSettings(vault)).toBeNull();
    expect((await resolveSealState(vault, root)).row).toBe("never-sealed");
    expect((await readInterviewLog(root, await pendingLogKey(vault))).events.map(event => event.type)).toContain("proposed");

    const sealed = payload(await handleInterview(context(vault), { op: "seal" }, deps));
    expect(sealed).toMatchObject({ ok: true, status: "sealed" });
    const vaultId = (await readVaultSettings(vault))!.vaultId;
    expect((await readStore(vaultId, root)).state).toBe("ok");
    const types = (await readInterviewLog(root, vaultId)).events.map(event => event.type);
    expect(types.at(-1)).toBe("sealed");
    expect(types).toContain("proposed");
  });

  it("rejects a confirm that cites an older proposal, and a seal answered through op answer", async () => {
    const { vault, root } = await freshVault();
    const deps = { ...clock(), root };
    await answerAll(vault, deps);
    const stale = payload(await handleInterview(context(vault), { op: "confirm", proposed: "0".repeat(64) }, deps));
    expect(stale).toMatchObject({ ok: false, status: "rejected", rejection: { code: "INTERVIEW_CONFIRM_STALE" } });
    const smuggled = payload(await handleInterview(context(vault), { op: "answer", answers: { seal: true } }, deps));
    expect(smuggled).toMatchObject({ ok: false, status: "rejected", rejection: { code: "INTERVIEW_SEAL_NOT_AN_ANSWER" } });
    const seal = payload(await handleInterview(context(vault), { op: "seal" }, deps));
    expect(seal).toMatchObject({ ok: false, status: "rejected", rejection: { code: "INTERVIEW_CONFIRM_REQUIRED" } });
    expect(await readVaultSettings(vault)).toBeNull();
    expect((await resolveSealState(vault, root)).row).toBe("never-sealed");
  });

  it("confirms nothing when nothing was proposed", async () => {
    const { vault, root } = await freshVault();
    const before = await snapshot(path.dirname(vault));
    const body = payload(await handleInterview(context(vault), { op: "confirm", proposed: "x" }, { ...clock(), root }));
    expect(body).toMatchObject({ ok: false, status: "rejected", rejection: { code: "INTERVIEW_NOTHING_PROPOSED" } });
    expect(await snapshot(path.dirname(vault))).toEqual(before);
  });

  it("rejects answer, confirm and seal on a working-directory target and leaves disk unchanged", async () => {
    const { base, vault, root } = await freshVault();
    const deps = { ...clock(), root };
    await answerAll(vault, deps);
    const before = await snapshot(base);
    for (const args of [{ op: "answer", answers: { anything: "x" } }, { op: "confirm", proposed: "x" }, { op: "seal" }]) {
      const result = await handleInterview(cwdContext(vault), args, deps);
      expect(result.isError).not.toBe(true);
      expect(payload(result)).toMatchObject({ ok: false, status: "rejected", rejection: { code: "target-unverified" } });
    }
    expect(payload(await handleInterview(cwdContext(vault), {}, deps))["status"]).toBe("proposed");
    expect(await snapshot(base)).toEqual(before);
  });

  it("maps a stale seal lock to INTERVIEW_SEAL_LOCK_STALE and never reclaims it", async () => {
    const { vault, root } = await freshVault();
    const now = 1_750_000_000_000;
    const reclaim = vi.fn(async () => true);
    const isPidAlive = vi.fn(() => false);
    const deps: InterviewToolDeps = { now: () => now, root, sealDeps: { now: () => now, isPidAlive, confirmStaleReclaim: reclaim } };
    // A vault whose id was issued by an earlier seal attempt, so the lock path is known.
    const vaultId = await ensureVaultId(vault);
    const proposed = await answerAll(vault, deps);
    await handleInterview(context(vault), { op: "confirm", proposed }, deps);
    const lock = path.join(root, `.${vaultId}.lock`);
    await writeFile(lock, JSON.stringify({ pid: 999_999, host: "other-host", startedAt: now - SEAL_LOCK_STALE_MS - 1 }));
    const before = await snapshot(root);

    const result = await handleInterview(context(vault), { op: "seal" }, deps);
    expect(result.isError).not.toBe(true);
    const body = payload(result);
    expect(body).toMatchObject({ ok: false, status: "rejected", rejection: { code: "INTERVIEW_SEAL_LOCK_STALE", recoverable: false } });
    expect(String((body["rejection"] as Record<string, unknown>)["remediation"])).toContain("in a terminal");
    expect(reclaim).not.toHaveBeenCalled();
    expect(await snapshot(root)).toEqual(before);
    expect((await readStore(vaultId, root)).state).toBe("absent");
  });

  it("passes a busy seal lock through as retryable", async () => {
    const { vault, root } = await freshVault();
    const now = 1_750_000_000_000;
    const deps: InterviewToolDeps = { now: () => now, root, sealDeps: { now: () => now, host: "this-host", isPidAlive: () => true } };
    const vaultId = await ensureVaultId(vault);
    const proposed = await answerAll(vault, deps);
    await handleInterview(context(vault), { op: "confirm", proposed }, deps);
    await writeFile(path.join(root, `.${vaultId}.lock`), JSON.stringify({ pid: 1, host: "this-host", startedAt: now }));
    const body = payload(await handleInterview(context(vault), { op: "seal" }, deps));
    expect(body).toMatchObject({ ok: false, status: "rejected", rejection: { code: "CONTRACT_SEAL_BUSY", retryable: true } });
  });

  // Root ignores permission bits, so the denial this test relies on never happens.
  it.skipIf(process.getuid?.() === 0)("still reports sealed, with a warning, when the sealed event cannot be logged", async () => {
    const { vault, root } = await freshVault();
    const deps = { ...clock(), root };
    const vaultId = await ensureVaultId(vault);
    const proposed = await answerAll(vault, deps);
    await handleInterview(context(vault), { op: "confirm", proposed }, deps);
    const events = path.join(stateDir(root, vaultId), "interview", "events.jsonl");
    await chmod(events, 0o400);
    try {
      const body = payload(await handleInterview(context(vault), { op: "seal" }, deps));
      expect(body).toMatchObject({ ok: true, status: "sealed" });
      expect(JSON.stringify(body)).toContain("INTERVIEW_LOG_UNRECORDED");
    } finally {
      await chmod(events, 0o600);
    }
    expect((await readStore(vaultId, root)).state).toBe("ok");
  });

  it("does not seal a new generation when a retried seal finds the confirmed contract already sealed", async () => {
    const { vault, root } = await freshVault();
    const deps = { ...clock(), root };
    const proposed = await answerAll(vault, deps);
    await handleInterview(context(vault), { op: "confirm", proposed }, deps);
    expect(payload(await handleInterview(context(vault), { op: "seal" }, deps))).toMatchObject({ ok: true, status: "sealed" });
    const vaultId = (await readVaultSettings(vault))!.vaultId;
    const generation = await currentSequence(vaultId, root);

    // The seal finished but its log entry was lost.
    const events = path.join(stateDir(root, vaultId), "interview", "events.jsonl");
    const lines = (await readFile(events, "utf8")).split("\n").filter(line => line !== "");
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ type: "sealed" });
    await writeFile(events, `${lines.slice(0, -1).join("\n")}\n`);

    const retried = payload(await handleInterview(context(vault), { op: "seal" }, deps));
    expect(retried).toMatchObject({ ok: true, status: "sealed" });
    // The contract is folders and properties only: no templates are sealed or reported as removed.
    expect(retried).not.toHaveProperty("templates");
    expect(retried).not.toHaveProperty("removedTemplates");
    expect(await currentSequence(vaultId, root)).toBe(generation);
    expect((await readInterviewLog(root, vaultId)).events.at(-1)?.type).toBe("sealed");
  });

  it("saves the chosen template folder when a retried seal finds the contract sealed but the folder unsaved", async () => {
    const { vault, root } = await freshVault();
    await mkdir(path.join(vault, "Templates"));
    const deps = { ...clock(), root };
    const proposed = await answerAll(vault, deps, { "template-folder:path": "Templates" });
    await handleInterview(context(vault), { op: "confirm", proposed }, deps);
    expect(payload(await handleInterview(context(vault), { op: "seal" }, deps))).toMatchObject({ ok: true, status: "sealed" });
    const settings = (await readVaultSettings(vault))!;
    expect(settings.templateFolder).toBe("Templates");
    const generation = await currentSequence(settings.vaultId, root);

    // The seal finished, but neither the template folder nor the log entry was saved.
    const { templateFolder: _unsaved, ...withoutFolder } = settings;
    await writeFile(path.join(vault, ".oms", "settings.json"), `${JSON.stringify(withoutFolder, null, 2)}\n`);
    const events = path.join(stateDir(root, settings.vaultId), "interview", "events.jsonl");
    const lines = (await readFile(events, "utf8")).split("\n").filter(line => line !== "");
    await writeFile(events, `${lines.slice(0, -1).join("\n")}\n`);
    expect((await readVaultSettings(vault))!.templateFolder).toBeUndefined();

    const retried = payload(await handleInterview(context(vault), { op: "seal" }, deps));
    expect(retried).toMatchObject({ ok: true, status: "sealed" });
    expect((retried["result"] as Record<string, unknown>)["warnings"]).toBeUndefined();
    expect(await currentSequence(settings.vaultId, root)).toBe(generation);
    expect((await readVaultSettings(vault))!.templateFolder).toBe("Templates");
  });

  /** Seals with `Templates` chosen, then loses the `sealed` log line; `edit` changes the settings and the proposal before the retry. */
  async function sealThenLoseLogLine(edit: (paths: { settings: string; proposal: Record<string, unknown> }) => Promise<void> = async () => undefined) {
    const { vault, root } = await freshVault();
    await mkdir(path.join(vault, "Templates"));
    const deps = { ...clock(), root };
    const proposed = await answerAll(vault, deps, { "template-folder:path": "Templates" });
    await handleInterview(context(vault), { op: "confirm", proposed }, deps);
    expect(payload(await handleInterview(context(vault), { op: "seal" }, deps))).toMatchObject({ ok: true, status: "sealed" });
    const settings = (await readVaultSettings(vault))!;
    const settingsPath = path.join(vault, ".oms", "settings.json");
    const { templateFolder: _unsaved, ...withoutFolder } = settings;
    await writeFile(settingsPath, `${JSON.stringify(withoutFolder, null, 2)}\n`);
    const events = path.join(stateDir(root, settings.vaultId), "interview", "events.jsonl");
    const lines = (await readFile(events, "utf8")).split("\n").filter(line => line !== "").slice(0, -1);
    const at = lines.findLastIndex(line => (JSON.parse(line) as { type: string }).type === "proposed");
    const proposal = JSON.parse(lines[at]!) as { payload: Record<string, unknown> };
    await edit({ settings: settingsPath, proposal: proposal.payload });
    lines[at] = JSON.stringify(proposal);
    await writeFile(events, `${lines.join("\n")}\n`);
    return { vault, root, deps, vaultId: settings.vaultId, generation: await currentSequence(settings.vaultId, root), settingsPath };
  }

  // Root ignores permission bits, so the denial this test relies on never happens.
  it.skipIf(process.getuid?.() === 0)("still reports the seal, with a warning, when a retried seal cannot save the template folder", async () => {
    const { vault, root, deps, vaultId, generation } = await sealThenLoseLogLine();
    const oms = path.join(vault, ".oms");
    await chmod(oms, 0o500);
    try {
      const retried = payload(await handleInterview(context(vault), { op: "seal" }, deps));
      expect(retried).toMatchObject({ ok: true, status: "sealed" });
      expect((retried["result"] as Record<string, unknown>)["warnings"]).toEqual([expect.stringMatching(/^INTERVIEW_TEMPLATE_FOLDER_UNRECORDED: the template folder was not saved/)]);
    } finally {
      await chmod(oms, 0o700);
    }
    expect(await currentSequence(vaultId, root)).toBe(generation);
    expect((await readVaultSettings(vault))!.templateFolder).toBeUndefined();
    expect((await readInterviewLog(root, vaultId)).events.at(-1)?.type).toBe("sealed");
  });

  it("leaves the settings as they are when a retried seal finds they already name a template folder", async () => {
    const { vault, deps, settingsPath } = await sealThenLoseLogLine(async ({ settings }) => {
      const current = JSON.parse(await readFile(settings, "utf8")) as Record<string, unknown>;
      await mkdir(path.join(path.dirname(path.dirname(settings)), "Other"));
      await writeFile(settings, `${JSON.stringify({ ...current, templateFolder: "Other" }, null, 2)}\n`);
    });
    const before = await readFile(settingsPath, "utf8");
    const retried = payload(await handleInterview(context(vault), { op: "seal" }, deps));
    expect(retried).toMatchObject({ ok: true, status: "sealed" });
    expect((retried["result"] as Record<string, unknown>)["warnings"]).toBeUndefined();
    expect(await readFile(settingsPath, "utf8")).toBe(before);
  });

  it("does not save a logged template folder that is not a usable folder in the vault", async () => {
    const { vault, root, deps, vaultId, generation } = await sealThenLoseLogLine(async ({ proposal }) => {
      proposal["templateFolder"] = "../outside";
    });
    const retried = payload(await handleInterview(context(vault), { op: "seal" }, deps));
    expect(retried).toMatchObject({ ok: true, status: "sealed" });
    expect((retried["result"] as Record<string, unknown>)["warnings"]).toEqual([expect.stringMatching(/^INTERVIEW_TEMPLATE_FOLDER_UNRECORDED: the logged template folder is not/)]);
    expect(await currentSequence(vaultId, root)).toBe(generation);
    expect((await readVaultSettings(vault))!.templateFolder).toBeUndefined();
  });

  it("does not take the already-sealed path, or write settings, when a retried seal finds no vault settings", async () => {
    const { vault, root, deps, vaultId, generation, settingsPath } = await sealThenLoseLogLine();
    await rm(settingsPath);
    const retried = payload(await handleInterview(context(vault), { op: "seal" }, deps));
    expect(retried).toMatchObject({ ok: false, status: "rejected" });
    expect(await currentSequence(vaultId, root)).toBe(generation);
    expect(await readVaultSettings(vault)).toBeNull();
  });
});
