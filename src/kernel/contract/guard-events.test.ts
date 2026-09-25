import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guardEventsPath, readTransportFailures } from "./guard-events.js";

const bases: string[] = [];

afterEach(async () => {
  await Promise.all(bases.splice(0).map(base => rm(base, { recursive: true, force: true })));
});

async function storeRootDirectory(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "oms-guard-events-"));
  bases.push(base);
  const root = join(base, "home", ".oms", "vaults");
  await mkdir(root, { recursive: true });
  return root;
}

describe("readTransportFailures", () => {
  it("reads the events file beside the store root", async () => {
    const root = await storeRootDirectory();
    expect(guardEventsPath(root)).toBe(join(root, "..", "guard-events.jsonl"));
  });

  it("counts a missing file as no failures", async () => {
    expect(await readTransportFailures(await storeRootDirectory())).toEqual({ total: 0, kinds: {} });
  });

  it("counts known kinds and skips malformed lines and unknown kinds", async () => {
    const root = await storeRootDirectory();
    await writeFile(guardEventsPath(root), [
      JSON.stringify({ ts: "2026-09-25T00:00:00.000Z", kind: "timeout" }),
      JSON.stringify({ ts: "2026-09-25T00:00:01.000Z", kind: "timeout" }),
      JSON.stringify({ ts: "2026-09-25T00:00:02.000Z", kind: "spawn-failed" }),
      JSON.stringify({ ts: "2026-09-25T00:00:03.000Z", kind: "not-a-kind" }),
      "null",
      "{broken",
      "",
    ].join("\n"));
    expect(await readTransportFailures(root)).toEqual({ total: 3, kinds: { timeout: 2, "spawn-failed": 1 } });
  });

  it("only reads: the events file is left as it was", async () => {
    const root = await storeRootDirectory();
    const text = `${JSON.stringify({ ts: "2026-09-25T00:00:00.000Z", kind: "internal" })}\n`;
    await writeFile(guardEventsPath(root), text);
    await readTransportFailures(root);
    expect(await readFile(guardEventsPath(root), "utf-8")).toBe(text);
    expect(await readdir(join(root, ".."))).toEqual(["guard-events.jsonl", "vaults"]);
  });
});

describe("judge isolation", () => {
  it("never lets the judge consult the guard events", async () => {
    const directory = new URL(".", import.meta.url);
    const judgeFiles = (await readdir(directory)).filter(name => name.startsWith("judge") && name.endsWith(".ts") && !name.endsWith(".test.ts"));
    expect(judgeFiles.sort()).toEqual(["judge-write.ts", "judge.ts"]);
    for (const name of judgeFiles) {
      const source = await readFile(new URL(name, directory), "utf-8");
      expect(source, name).not.toMatch(/guard-events/u);
    }
  });
});
