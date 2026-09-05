import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Every suite (including its CLI children) gets disposable external history.
// Production journal defaults must never write into a developer's real history.
const previous = process.env.OMS_RUNTIME_ROOT;
const root = mkdtempSync(join(tmpdir(), "oms-test-runtime-"));
process.env.OMS_RUNTIME_ROOT = root;
afterAll(() => {
  if (previous === undefined) delete process.env.OMS_RUNTIME_ROOT;
  else process.env.OMS_RUNTIME_ROOT = previous;
  rmSync(root, { recursive: true, force: true });
});
