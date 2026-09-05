import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBridgeCommand } from "./link-command.js";

let roots: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  process.exitCode = undefined;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

async function capture(run: () => Promise<void>): Promise<{ out: string; err: string; code: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...values: unknown[]) => out.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) => err.push(values.map(String).join(" "));
  process.exitCode = undefined;
  try {
    await run();
    return { out: out.join("\n"), err: err.join("\n"), code: process.exitCode as number | undefined };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("bridge family", () => {
  it("adds, reports, and removes a repository bridge without touching vault notes", async () => {
    const repo = await root("oms-bridge-repo-");
    const vault = await root("oms-bridge-vault-");
    await mkdir(path.join(vault, "notes"));
    await writeFile(path.join(vault, "notes", "kept.md"), "keep me\n", "utf8");
    process.chdir(repo);

    const added = await capture(() => runBridgeCommand(["add", "--vault", vault, "--folder", "notes", "--no-convention-note"]));
    expect(added.code).toBe(0);
    expect(await readFile(path.join(repo, ".oms", "links.yaml"), "utf8")).toContain(vault);
    expect(path.resolve(path.dirname(path.join(repo, ".oms", "linked", "notes")), await readlink(path.join(repo, ".oms", "linked", "notes")))).toBe(path.join(vault, "notes"));

    const status = await capture(() => runBridgeCommand(["status", "--json"]));
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out)).toMatchObject({ state: "linked", vault, scope: ["notes"], links: [{ folder: "notes", state: "linked" }] });

    const removed = await capture(() => runBridgeCommand(["remove", "--yes", "--json"]));
    expect(removed.code).toBe(0);
    await expect(readFile(path.join(repo, ".oms", "links.yaml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(vault, "notes", "kept.md"), "utf8")).toBe("keep me\n");
  });

  it("status is read-only and does not create bridge files", async () => {
    const repo = await root("oms-bridge-empty-");
    process.chdir(repo);
    const status = await capture(() => runBridgeCommand(["status", "--json"]));
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out)).toMatchObject({ state: "not-linked" });
    await expect(readFile(path.join(repo, ".oms", "links.yaml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
