import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectInstalledAssets } from "../kernel/install/asset-health.js";
import { computeTreeDigest } from "../kernel/install/provenance.js";

vi.mock("../kernel/install/asset-health.js", () => ({
  inspectInstalledAssets: vi.fn(async () => ({
    status: "ok",
    assets: [
      { id: "hook:oms-guard", kind: "hook", declaredPath: "/bin/oms-guard", realPath: "/bin/oms-guard", state: "ok", remediation: "" },
    ],
  })),
}));

vi.mock("../kernel/templates/index.js", () => ({
  diagnoseTemplates: vi.fn(async () => ({
    status: "healthy",
    migrationMarker: "none",
    managedSourceExclusions: [],
    unresolvedLegacyNotes: [],
    diagnostics: [],
  })),
}));

import { runDoctor } from "./doctor-lint.js";

const packageVersion = (JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as { version: string }).version;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("doctor Hermes provenance", () => {
  it.each(["not-installed", "match", "drift"] as const)("reports %s provenance in JSON and text", async state => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-doctor-hermes-"));
    roots.push(root);
    const skillRoot = path.join(root, "skills", "knowledge-management", "oms");
    const provenancePath = path.join(root, "adapters", "oms", "oms-provenance.json");
    const originalOverride = process.env.OMS_HERMES_HOME;
    process.env.OMS_HERMES_HOME = root;
    try {
      if (state !== "not-installed") {
        await mkdir(skillRoot, { recursive: true });
        await mkdir(path.dirname(provenancePath), { recursive: true });
        await writeFile(path.join(skillRoot, "SKILL.md"), "# OMS\n");
        await writeFile(provenancePath, `${JSON.stringify({
          schemaVersion: 1,
          source: "npm",
          version: state === "match" ? packageVersion : "0.10.1",
          skillTreeDigest: await computeTreeDigest(skillRoot),
          installedAt: "2026-01-01T00:00:00.000Z",
        })}\n`);
      }

      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(await runDoctor({ vault: "/vault", json: true })).toBe(0);
      const json = JSON.parse(String(log.mock.calls[0]?.[0])) as { hermesProvenance: unknown; installAssets: unknown };
      expect(json.installAssets).toEqual({
        status: "ok",
        assets: [{ id: "hook:oms-guard", kind: "hook", declaredPath: "/bin/oms-guard", realPath: "/bin/oms-guard", state: "ok", remediation: "" }],
      });
      expect(json.hermesProvenance).toEqual(
        state === "not-installed"
          ? { state, packageVersion, recordedVersion: null, digestMatch: null }
          : { state, packageVersion, recordedVersion: state === "match" ? packageVersion : "0.10.1", digestMatch: true },
      );

      log.mockClear();
      expect(await runDoctor({ vault: "/vault" })).toBe(0);
      expect(log.mock.calls.map(call => call[0]).filter(line => typeof line === "string" && line.startsWith("Hermes provenance:"))).toEqual([
        `Hermes provenance: ${state} (package ${packageVersion}, recorded ${state === "not-installed" ? "none" : state === "match" ? packageVersion : "0.10.1"}).`,
      ]);
      expect(existsSync(root)).toBe(true);
    } finally {
      if (originalOverride === undefined) delete process.env.OMS_HERMES_HOME;
      else process.env.OMS_HERMES_HOME = originalOverride;
    }
  });

  it("includes degraded install assets in text doctor output", async () => {
    vi.mocked(inspectInstalledAssets).mockResolvedValueOnce({
      status: "degraded",
      assets: [{
        id: "binary:oms-guard",
        kind: "binary",
        declaredPath: "/bin/oms-guard",
        realPath: null,
        state: "dangling-symlink",
        remediation: "oms install --host claude",
      }],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await runDoctor({ vault: "/vault" })).toBe(0);
    expect(log.mock.calls.map(call => call[0])).toContain("Install assets: degraded (1 of 1 unusable).");
    expect(log.mock.calls.map(call => call[0])).toContain("  [DANGLING_SYMLINK] /bin/oms-guard — oms install --host claude");
  });
});
