import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it("does not retain large source-string backing through compact live projections", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const output = execFileSync(process.execPath, ["--expose-gc", path.join(root, "scripts/bench/live-projection-retention.mjs")], {
    cwd: root, encoding: "utf8", timeout: 30_000,
  });
  const result = JSON.parse(output) as { count: number; retainedHeapDelta: number };
  expect(result.count).toBe(24);
  expect(result.retainedHeapDelta).toBeLessThan(8 * 1024 * 1024);
}, 30_000);
