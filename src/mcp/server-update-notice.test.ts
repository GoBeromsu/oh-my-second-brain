import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { updateNoticeCachePath } from "./update-notice.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
const fixtureVault = path.join(repoRoot, "test", "fixtures", "vault");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");

async function installedVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf-8"));
  const version =
    typeof manifest === "object" && manifest !== null && "version" in manifest
      ? (manifest as { version: unknown }).version
      : undefined;
  expect(typeof version).toBe("string");
  return String(version);
}

async function instructionsWithStateDir(stateDir: string): Promise<string | undefined> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distCli, "mcp", "--vault", fixtureVault],
    cwd: repoRoot,
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      OMS_AUTO_UPDATE_STATE_DIR: stateDir,
      // No registry reachable through this stub: the boot path must not need one.
      OMS_UPDATE_LATEST_VERSION: "99.0.0",
    },
  });
  const client = new Client({ name: "oms-update-notice-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    return client.getInstructions();
  } finally {
    await client.close();
  }
}

describe("MCP server instructions update nudge", () => {
  it("appends exactly one nudge line when the cache is fresh and newer", async () => {
    // Given: a fresh stable cache advertising a far newer version
    const stateDir = await mkdtemp(path.join(tmpdir(), "oms-mcp-nudge-fresh-"));
    try {
      const current = await installedVersion();
      await writeFile(
        updateNoticeCachePath({ OMS_AUTO_UPDATE_STATE_DIR: stateDir }),
        JSON.stringify({
          version: 1,
          channels: { stable: { latestVersion: "99.0.0", checkedAt: Date.now() } },
        }),
        "utf-8",
      );

      // When: a client completes the initialize handshake
      const instructions = await instructionsWithStateDir(stateDir);

      // Then: the base instructions carry one extra nudge line naming both versions
      expect(instructions).toBeDefined();
      const lines = (instructions ?? "").split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("Oh My Second Brain exposes ontology/status/cache/retrieval tools");
      expect(lines[1]).toContain(`${current} -> 99.0.0`);
      expect(lines[1]).toContain("oms update --yes");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("emits no nudge line when the cache is missing", async () => {
    // Given: an empty state dir (no cache file at all)
    const stateDir = await mkdtemp(path.join(tmpdir(), "oms-mcp-nudge-missing-"));
    try {
      // When: a client completes the initialize handshake
      const instructions = await instructionsWithStateDir(stateDir);

      // Then: the instructions are exactly the base line
      expect((instructions ?? "").split("\n")).toHaveLength(1);
      expect(instructions).not.toContain("Update available");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("emits no nudge line when the cached stamp is past the 24h TTL", async () => {
    // Given: a stable cache stamped 25 hours ago
    const stateDir = await mkdtemp(path.join(tmpdir(), "oms-mcp-nudge-stale-"));
    try {
      await writeFile(
        updateNoticeCachePath({ OMS_AUTO_UPDATE_STATE_DIR: stateDir }),
        JSON.stringify({
          version: 1,
          channels: {
            stable: { latestVersion: "99.0.0", checkedAt: Date.now() - 25 * 60 * 60 * 1000 },
          },
        }),
        "utf-8",
      );

      // When: a client completes the initialize handshake
      const instructions = await instructionsWithStateDir(stateDir);

      // Then: stale state yields the base instructions only
      expect((instructions ?? "").split("\n")).toHaveLength(1);
      expect(instructions).not.toContain("Update available");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 60_000);
});
