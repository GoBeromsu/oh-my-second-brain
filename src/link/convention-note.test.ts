import { mkdir, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLink } from "../cli/link-command.js";
import {
  CONVENTION_NOTE_BEGIN,
  CONVENTION_NOTE_END,
  conventionUsageSection,
  writeConventionUsageSection,
} from "./convention-note.js";

let tmp: string;
let repo: string;
let vault: string;

beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "oms-convention-note-test-"));
  repo = path.join(tmp, "repo");
  vault = path.join(tmp, "vault");
  await mkdir(repo, { recursive: true });
  await mkdir(path.join(vault, "notes"), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function markerCount(content: string, marker: string): number {
  return content.split(marker).length - 1;
}

describe("writeConventionUsageSection", () => {
  it("creates AGENTS.md with the managed OMS usage section", async () => {
    const result = await writeConventionUsageSection(repo, vault);
    const content = await readFile(path.join(repo, "AGENTS.md"), "utf-8");

    expect(result).toEqual({
      agentsPath: path.join(repo, "AGENTS.md"),
      changed: true,
      created: true,
      replaced: false,
    });
    expect(content).toContain(CONVENTION_NOTE_BEGIN);
    expect(content).toContain(CONVENTION_NOTE_END);
    expect(content).toContain(`- Connected vault: ${path.basename(vault)}`);
    expect(content).not.toContain(vault);
    expect(content).toContain("`oms query \"what context should I know for this change?\"`");
    expect(content).toContain("`oms search \"keyword or topic\"`");
    expect(content).toContain("`oms get \"note-id-or-path\"`");
    expect(content).toContain("`oms mcp`");
  });

  it("replaces the managed block idempotently on rerun", async () => {
    const oldVault = path.join(tmp, "old-vault");
    await writeFile(
      path.join(repo, "AGENTS.md"),
      `${conventionUsageSection(oldVault)}\n\nUser-owned notes stay here.\n`,
      "utf-8",
    );

    const result = await writeConventionUsageSection(repo, vault);
    const content = await readFile(path.join(repo, "AGENTS.md"), "utf-8");
    const second = await writeConventionUsageSection(repo, vault);
    const afterSecond = await readFile(path.join(repo, "AGENTS.md"), "utf-8");

    expect(result.changed).toBe(true);
    expect(result.created).toBe(false);
    expect(result.replaced).toBe(true);
    expect(content).toContain(`- Connected vault: ${path.basename(vault)}`);
    expect(content).not.toContain(oldVault);
    expect(content).not.toContain(vault);
    expect(content).toContain("User-owned notes stay here.");
    expect(markerCount(content, CONVENTION_NOTE_BEGIN)).toBe(1);
    expect(markerCount(content, CONVENTION_NOTE_END)).toBe(1);
    expect(second.changed).toBe(false);
    expect(afterSecond).toBe(content);
  });

  it("preserves existing user content outside the managed block", async () => {
    const before = "# Repo Rules\n\nKeep this prefix.\n\n";
    const after = "\n\nKeep this suffix exactly.\n";
    await writeFile(
      path.join(repo, "AGENTS.md"),
      `${before}${CONVENTION_NOTE_BEGIN}\nstale generated text\n${CONVENTION_NOTE_END}${after}`,
      "utf-8",
    );

    await writeConventionUsageSection(repo, vault);
    const content = await readFile(path.join(repo, "AGENTS.md"), "utf-8");

    expect(content.startsWith(before)).toBe(true);
    expect(content.endsWith(after)).toBe(true);
    expect(content).not.toContain("stale generated text");
  });
  it("replaces only the first duplicate managed block and removes the rest", async () => {
    const staleBlock = `${CONVENTION_NOTE_BEGIN}\nstale generated text\n${CONVENTION_NOTE_END}`;
    await writeFile(
      path.join(repo, "AGENTS.md"),
      `Prefix\n\n${staleBlock}\n\nUser notes between.\n\n${staleBlock}\n\nSuffix\n`,
      "utf-8",
    );

    await writeConventionUsageSection(repo, vault);
    const content = await readFile(path.join(repo, "AGENTS.md"), "utf-8");

    expect(markerCount(content, CONVENTION_NOTE_BEGIN)).toBe(1);
    expect(markerCount(content, CONVENTION_NOTE_END)).toBe(1);
    expect(content).not.toContain("stale generated text");
    expect(content).toContain("User notes between.");
    expect(content).toContain("Suffix");
  });

  it("honors link command opt-out by skipping AGENTS.md generation", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const status = await runLink({
      cwd: repo,
      vault,
      vaultExplicit: true,
      folders: ["notes"],
      conventionNote: false,
    });

    expect(status).toBe(0);
    expect(await pathExists(path.join(repo, "AGENTS.md"))).toBe(false);
  });
});
