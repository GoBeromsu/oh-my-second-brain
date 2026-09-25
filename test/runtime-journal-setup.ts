import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Every suite, including CLI children, gets disposable history and XDG homes.
// Production defaults must never write into a developer's real home or history.
const ISOLATED = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "OMS_RUNTIME_ROOT",
] as const;

const previous = Object.fromEntries(ISOLATED.map((name) => [name, process.env[name]]));
const root = realpathSync(mkdtempSync(join(tmpdir(), "oms-test-runtime-")));
process.env.OMS_TEST_HOST_HOME = previous.HOME;
process.env.HOME = join(root, "home");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_STATE_HOME = join(root, "state");
process.env.XDG_CACHE_HOME = join(root, "cache");
process.env.OMS_RUNTIME_ROOT = join(root, "runtime");

afterAll(() => {
  for (const name of ISOLATED) {
    const value = previous[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete process.env.OMS_TEST_HOST_HOME;
  rmSync(root, { recursive: true, force: true });
});
