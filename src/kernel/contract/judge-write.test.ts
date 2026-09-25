import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { judgeReadyTarget, resolveWriteTarget } from "./judge-write.js";

const directories: string[] = [];

async function tempVault(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "oms-judge-write-")));
  directories.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("resolveWriteTarget seal state failures", () => {
  it("maps a throwing seal resolver to an unreadable contract that the judge denies", async () => {
    const vault = await tempVault();
    const resolved = await resolveWriteTarget(vault, join(vault, "a.md"), {
      resolveSealState: async () => { throw new Error("store exploded"); },
    });
    expect(resolved.state).toBe("ready");
    if (resolved.state !== "ready") return;
    expect(resolved.view).toEqual({ state: "unreadable" });
    expect(judgeReadyTarget(resolved, "---\nstatus: open\n---\nbody\n")).toEqual({
      ok: false,
      violations: [{ field: "contract", kind: "contract-unreadable" }],
      missingDefaults: [],
    });
  });

  it("uses the injected resolver's view when it succeeds", async () => {
    const vault = await tempVault();
    const resolved = await resolveWriteTarget(vault, join(vault, "a.md"), {
      resolveSealState: async () => ({ row: "never-sealed", view: { state: "open" }, vaultId: null, shared: false, settingsInvalid: false }),
    });
    expect(resolved.state === "ready" && resolved.view).toEqual({ state: "open" });
  });
});
