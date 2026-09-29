import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, readPolicy, writePolicy, type EvolutionPolicy } from "./policy.js";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
let base: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-evo-policy-")));
  root = join(base, "home", ".oms", "vaults");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const policyPath = (): string => join(root, `.${ID}.state`, "evolution", "policy.json");
const ON: EvolutionPolicy = { version: 1, autonomous: true, limits: { perDay: 1, perWeek: 3 } };

async function stored(text: string): Promise<void> {
  await mkdir(join(root, `.${ID}.state`, "evolution"), { recursive: true, mode: 0o700 });
  await writeFile(policyPath(), text, { mode: 0o600 });
}

describe("evolution policy", () => {
  it("is off by default and reading creates nothing", async () => {
    expect(await readPolicy(root, ID)).toEqual({ state: "absent", policy: DEFAULT_POLICY });
    expect(DEFAULT_POLICY.autonomous).toBe(false);
    await expect(readFile(policyPath())).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(join(root, `.${ID}.state`, "evolution"), { recursive: true, mode: 0o700 });
    expect((await readPolicy(root, ID)).state).toBe("absent");
  });

  it("turns on only in an interactive context", async () => {
    await expect(writePolicy(root, ID, ON, { interactive: false })).rejects.toMatchObject({ code: "EVOLUTION_POLICY_REQUIRES_TTY" });
    await expect(readFile(policyPath())).rejects.toMatchObject({ code: "ENOENT" });
    await writePolicy(root, ID, ON, { interactive: true });
    expect(await readPolicy(root, ID)).toEqual({ state: "ok", policy: ON });
  });

  it("turns off without a TTY", async () => {
    await writePolicy(root, ID, ON, { interactive: true });
    await writePolicy(root, ID, { ...ON, autonomous: false }, { interactive: false });
    expect((await readPolicy(root, ID)).policy.autonomous).toBe(false);
  });

  it("lowers limits but never raises them", async () => {
    await writePolicy(root, ID, { ...ON, limits: { perDay: 0, perWeek: 2 } }, { interactive: true });
    expect((await readPolicy(root, ID)).policy.limits).toEqual({ perDay: 0, perWeek: 2 });
    await expect(writePolicy(root, ID, { ...ON, limits: { perDay: 2, perWeek: 3 } }, { interactive: true })).rejects.toMatchObject({ code: "EVOLUTION_POLICY_LIMIT_RAISED" });
    await expect(writePolicy(root, ID, { ...ON, limits: { perDay: 1, perWeek: 4 } }, { interactive: true })).rejects.toMatchObject({ code: "EVOLUTION_POLICY_LIMIT_RAISED" });
    await expect(writePolicy(root, ID, { ...ON, limits: { perDay: 0.5, perWeek: 1 } }, { interactive: true })).rejects.toMatchObject({ code: "EVOLUTION_POLICY_LIMIT_RAISED" });
    expect((await readPolicy(root, ID)).policy.limits).toEqual({ perDay: 0, perWeek: 2 });
  });

  it.each([
    ["not json", "{"],
    ["an array", "[]"],
    ["a wrong version", JSON.stringify({ ...ON, version: 2 })],
    ["a non-boolean switch", JSON.stringify({ ...ON, autonomous: "yes" })],
    ["no limits", JSON.stringify({ version: 1, autonomous: true })],
    ["a raised limit", JSON.stringify({ ...ON, limits: { perDay: 5, perWeek: 3 } })],
    ["a negative limit", JSON.stringify({ ...ON, limits: { perDay: -1, perWeek: 3 } })],
  ])("reads %s as off", async (_name, text) => {
    await stored(text);
    expect(await readPolicy(root, ID)).toEqual({ state: "invalid", policy: DEFAULT_POLICY });
  });

  it("reads an oversized policy as off", async () => {
    await stored(" ".repeat(64 * 1024 + 1));
    expect((await readPolicy(root, ID)).state).toBe("invalid");
  });

  it("refuses a policy file replaced by a symlink", async () => {
    await mkdir(join(root, `.${ID}.state`, "evolution"), { recursive: true, mode: 0o700 });
    await writeFile(join(base, "target"), JSON.stringify(ON));
    await symlink(join(base, "target"), policyPath());
    await expect(readPolicy(root, ID)).rejects.toMatchObject({ code: "STATE_DIR_UNSAFE" });
    await expect(writePolicy(root, ID, ON, { interactive: true })).rejects.toMatchObject({ code: "STATE_DIR_UNSAFE" });
  });
});
