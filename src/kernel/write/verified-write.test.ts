import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTruthTableRow, type TruthTableFixture } from "../../../test/fixtures/contract-truth-table.js";
import { verifiedWriteNote } from "./verified-write.js";

const fixtures: TruthTableFixture[] = [];
let savedEnv: Record<string, string | undefined>;

async function fixtureFor(row: "sealed" | "never-sealed"): Promise<TruthTableFixture> {
  const fixture = await buildTruthTableRow(row);
  fixtures.push(fixture);
  const home = path.join(fixture.base, "home");
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  return fixture;
}

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OMS_") || key.startsWith("XDG_")) delete process.env[key];
  }
});

afterEach(async () => {
  // Restore key by key: replacing `process.env` itself would detach it from the
  // real environment that `os.homedir()` reads.
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
});

describe("verifiedWriteNote", () => {
  it("rejects a cwd-inferred target before touching disk", async () => {
    const fixture = await fixtureFor("sealed");
    const before = await readdir(fixture.vault);
    const result = await verifiedWriteNote({ vault: fixture.vault, source: "cwd", path: "Projects/a.md", content: "x\n" });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.rejection.code).toBe("target-unverified");
    expect(await readdir(fixture.vault)).toEqual(before);
  });

  it("denies a note the sealed contract does not allow and leaves disk untouched", async () => {
    const fixture = await fixtureFor("sealed");
    const result = await verifiedWriteNote({ vault: fixture.vault, source: "explicit", path: "Loose/a.md", content: "x\n" });
    expect(result).toEqual({ kind: "denied", violations: [expect.objectContaining({ field: "path", kind: "unregistered-folder" })] });
    await expect(readFile(path.join(fixture.vault, "Loose", "a.md"), "utf8")).rejects.toThrow();
  });

  it("writes an allowed note and reports its vault-relative path", async () => {
    const fixture = await fixtureFor("sealed");
    const result = await verifiedWriteNote({ vault: fixture.vault, source: "explicit", path: "Projects/a.md", content: "Body\n" });
    expect(result).toEqual({ kind: "written", path: "Projects/a.md", missingDefaults: [] });
    expect(await readFile(path.join(fixture.vault, "Projects", "a.md"), "utf8")).toBe("Body\n");
  });

  it("asks for a retry when the note appears between the verdict and the save", async () => {
    const fixture = await fixtureFor("never-sealed");
    const target = path.join(fixture.vault, "Projects", "a.md");
    await mkdir(path.dirname(target), { recursive: true });
    const beforePublish = vi.fn(async () => { await writeFile(target, "raced\n"); });
    const result = await verifiedWriteNote(
      { vault: fixture.vault, source: "explicit", path: "Projects/a.md", content: "mine\n" },
      { beforePublish },
    );
    expect(beforePublish).toHaveBeenCalledOnce();
    expect(result).toEqual({ kind: "retry", state: "changed" });
    expect(await readFile(target, "utf8")).toBe("raced\n");
  });
});
