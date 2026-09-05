import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as linkDetection from "../kernel/conventions/lint.js";
import { runLinkCheck } from "./link-check.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function vaultWithFindings(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-link-check-"));
  roots.push(vault);
  await mkdir(path.join(vault, "notes"), { recursive: true });
  await writeFile(path.join(vault, "notes", "source.md"), "A [[Missing]] link.\n", "utf8");
  await writeFile(path.join(vault, "notes", "orphan.md"), "No incoming links.\n", "utf8");
  return vault;
}

async function vaultBytes(vault: string, relative = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(vault, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      result[`${child}/`] = "directory";
      Object.assign(result, await vaultBytes(vault, child));
    } else {
      result[child] = (await readFile(path.join(vault, child))).toString("base64");
    }
  }
  return result;
}

describe("runLinkCheck", () => {
  it("reports link diagnostics as warnings and leaves the whole vault unchanged", async () => {
    const vault = await vaultWithFindings();
    const before = await vaultBytes(vault);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await runLinkCheck({ vault })).toBe(0);
    const output = String(log.mock.calls[0]?.[0]);
    expect(output).toContain("[[Missing]]");
    expect(output).toContain("orphan note(s)");
    expect(output).toContain("warnings (non-blocking). Exit 0.");
    expect(await vaultBytes(vault)).toEqual(before);
  });

  it("honors verbosity while keeping findings warning-only", async () => {
    const vault = await vaultWithFindings();
    for (let index = 0; index < 21; index += 1) {
      await writeFile(path.join(vault, "notes", `extra-${String(index).padStart(2, "0")}.md`), "Unlinked.\n", "utf8");
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await runLinkCheck({ vault })).toBe(0);
    const concise = String(log.mock.calls[0]?.[0]);
    expect(concise).toContain("… and 3 more");
    expect(concise).toContain("Run `oms link check --verbose`");

    log.mockClear();
    expect(await runLinkCheck({ vault, verbose: true })).toBe(0);
    const verbose = String(log.mock.calls[0]?.[0]);
    expect(verbose).toContain("extra-20.md");
    expect(verbose).not.toContain("Run `oms link check --verbose`");
  });

  it("emits the exact read-only JSON receipt", async () => {
    const vault = await vaultWithFindings();
    const before = await vaultBytes(vault);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await runLinkCheck({ vault, json: true })).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      totalNotes: 2,
      brokenLinks: [{ notePath: "notes/source.md", target: "Missing" }],
      orphanPaths: ["notes/orphan.md", "notes/source.md"],
    });
    expect(await vaultBytes(vault)).toEqual(before);
  });

  it("reports a detection failure through the canonical link check name", async () => {
    const vault = await vaultWithFindings();
    const before = await vaultBytes(vault);
    vi.spyOn(linkDetection, "detectLinkIssues").mockRejectedValueOnce(new Error("unreadable vault"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runLinkCheck({ vault })).toBe(1);
    expect(error).toHaveBeenCalledWith("[oms] link check could not complete: unreadable vault");
    expect(await vaultBytes(vault)).toEqual(before);
  });
});
