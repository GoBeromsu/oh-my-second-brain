import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runAudit } from "./audit.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function vault(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "oms-audit-cli-")));
  roots.push(root);
  return root;
}

describe("runAudit failures", () => {
  it("names a filesystem failure by code without echoing the path", async () => {
    const root = await vault();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runAudit({ vault: root, folder: "Missing" })).toBe(1);
    expect(error).toHaveBeenCalledWith("[oms] audit could not complete: ENOENT: the vault or audit folder could not be read");
    expect(JSON.stringify(error.mock.calls)).not.toContain(root);
  });

  it("keeps its own input errors verbatim", async () => {
    const root = await vault();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runAudit({ vault: root, folder: "a/b" })).toBe(1);
    expect(await runAudit({ vault: root, maxPerTemplate: 0 })).toBe(1);
    expect(error.mock.calls).toEqual([
      ["[oms] audit could not complete: Audit folder must be one safe top-level name without path separators."],
      ["[oms] audit could not complete: Audit maxPerTemplate must be a safe positive integer."],
    ]);
  });
});
