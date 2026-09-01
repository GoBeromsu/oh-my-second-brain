import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { harnessSurfaceRegistry } from "../../kernel/harness/surface-registry.js";
import { installHermes } from "./hermes.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("installHermes transaction", () => {
  it("rejects an unsafe config before writing OMS-owned targets", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-"));
    temporaryDirectories.push(home);
    const hermes = path.join(home, ".hermes");
    const config = path.join(hermes, "config.yaml");
    const original = "mcp_servers: &servers {}\n";
    await mkdir(hermes);
    await writeFile(config, original);
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");

    await expect(installHermes({
      action: "install",
      runtime: "hermes",
      vault: "/vault",
      homeDir: home,
      adapterRoot: path.resolve("."),
    }, host)).rejects.toThrow("unsafe YAML edit");

    expect(await readFile(config, "utf8")).toBe(original);
    await expect(readFile(path.join(hermes, "adapters", "oms", "hermes-manifest.json"))).rejects.toThrow();
  });
});
