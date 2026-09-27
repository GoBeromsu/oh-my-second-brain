import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installScript = path.join(repoRoot, "scripts", "install.sh");
const tempRoots: string[] = [];

/**
 * F3 regression harness.
 *
 * `scripts/install.sh` mutates the user's DEFAULT Node (`volta install
 * node@24`) before installing OMS. Under `set -e` any later failure used to
 * skip the restore line and leave that default rewritten. These tests drive
 * the real script with a fake `volta` on PATH that records every invocation
 * and can be told which step fails.
 *
 * `failAt` selects the failing step: "package" (the OMS package install) or
 * "host" (the `volta run oms host install ...` step).
 */
function runInstaller(failAt: "none" | "package" | "host"): { status: number | null; calls: string[] } {
  const root = mkdtempSync(path.join(tmpdir(), "oms-install-sh-"));
  tempRoots.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = path.join(root, "volta-calls.log");
  const volta = path.join(bin, "volta");
  writeFileSync(
    volta,
    `#!/bin/sh
printf '%s\\n' "volta $*" >> "${log}"
if [ "$1" = "list" ]; then
  printf 'runtime node@22.11.0 (default)\\n'
  exit 0
fi
if [ "$1" = "install" ]; then
  case "$2" in
    node@*) exit 0 ;;
    *) [ "${failAt}" = "package" ] && exit 17
       exit 0 ;;
  esac
fi
if [ "$1" = "run" ]; then
  [ "${failAt}" = "host" ] && exit 19
  exit 0
fi
exit 0
`,
    "utf-8",
  );
  chmodSync(volta, 0o755);

  const result = spawnSync("bash", [installScript, "--vault", root], {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}` },
    encoding: "utf-8",
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, "utf-8").trim().split("\n").filter((line) => line.length > 0);
  } catch {
    calls = [];
  }
  return { status: result.status, calls };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("scripts/install.sh default Node restoration", () => {
  it.each([
    ["the package install fails", "package" as const, 17],
    ["the host install fails", "host" as const, 19],
  ])("restores the previous default Node when %s", (_label, failAt, expectedStatus) => {
    const { status, calls } = runInstaller(failAt);

    expect(status).toBe(expectedStatus);
    expect(calls).toContain("volta install node@24");
    expect(calls.at(-1)).toBe("volta install node@22.11.0");
  });

  it("restores the previous default Node on a successful install", () => {
    const { status, calls } = runInstaller("none");

    expect(status).toBe(0);
    expect(calls).toContain("volta install node@24");
    expect(calls.at(-1)).toBe("volta install node@22.11.0");
  });
});
