import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectInstalledAssets } from "../kernel/install/asset-health.js";

vi.mock("../kernel/install/asset-health.js", () => ({ inspectInstalledAssets: vi.fn(async () => ({ status: "ok", hosts: [], assets: [] })) }));
vi.mock("../kernel/templates/index.js", () => ({ diagnoseTemplates: vi.fn(async () => ({ status: "healthy", migrationMarker: "none", managedSourceExclusions: [], unresolvedLegacyNotes: [], diagnostics: [] })) }));
vi.mock("./host-probe.js", () => ({ discoverHostInstallAssets: vi.fn(async () => ({ hosts: [{ host: "claude", state: "not-installed" }, { host: "codex", state: "not-installed" }, { host: "hermes", state: "not-installed" }], assets: [] })) }));

import { runDoctor } from "./doctor-lint.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("doctor install assets", () => {
  it.each([
    ["not-installed", { hosts: [{ host: "hermes", state: "not-installed" }], assets: [] }, { packageVersion: "0.12.3", recordedVersion: null, digestMatch: null }],
    ["match", { hosts: [{ host: "hermes", state: "ok" }], assets: [{ id: "hermes:0", kind: "skill-tree", declaredPath: "/skills", realPath: "/skills", state: "ok", cause: null, remediation: "", packageVersion: "0.12.3", recordedVersion: "0.12.3", digestMatch: true }] }, { packageVersion: "0.12.3", recordedVersion: "0.12.3", digestMatch: true }],
    ["drift", { hosts: [{ host: "hermes", state: "degraded" }], assets: [{ id: "hermes:0", kind: "skill-tree", declaredPath: "/skills", realPath: "/skills", state: "provenance-mismatch", cause: null, remediation: "oms install", packageVersion: "0.12.3", recordedVersion: "0.12.2", digestMatch: false }] }, { packageVersion: "0.12.3", recordedVersion: "0.12.2", digestMatch: false }],
  ] as const)("reports %s Hermes provenance in JSON and text", async (state, health, evidence) => {
    const version = (JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as { version: string }).version;
    const adjustedEvidence = { ...evidence, packageVersion: version, recordedVersion: state === "match" ? version : evidence.recordedVersion };
    const adjustedHealth = {
      ...health,
      assets: health.assets.map(asset => ({ ...asset, packageVersion: version, recordedVersion: state === "match" ? version : asset.recordedVersion })),
    };
    vi.mocked(inspectInstalledAssets).mockResolvedValueOnce({ status: state === "drift" ? "degraded" : "ok", ...adjustedHealth });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await runDoctor({ vault: "/vault", json: true })).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ hermesProvenance: { state, ...adjustedEvidence } });

    vi.mocked(inspectInstalledAssets).mockResolvedValueOnce({ status: state === "drift" ? "degraded" : "ok", ...adjustedHealth });
    log.mockClear();
    expect(await runDoctor({ vault: "/vault" })).toBe(0);
    expect(log.mock.calls.map(call => call[0])).toContain(
      `Hermes provenance: ${state} (packageVersion=${version}, recordedVersion=${adjustedEvidence.recordedVersion ?? "none"}, digestMatch=${adjustedEvidence.digestMatch ?? "unknown"}).`,
    );
  });

  it("includes the resolved symlink target and inspection cause in text diagnostics", async () => {
    vi.mocked(inspectInstalledAssets).mockResolvedValueOnce({ status: "degraded", hosts: [{ host: "claude", state: "degraded" }], assets: [{ id: "hermes:0", kind: "skill-tree", declaredPath: "/skills", realPath: "/skills", state: "provenance-mismatch", cause: null, remediation: "oms install --vault \"/vault\" --runtime hermes", packageVersion: "0.12.3", recordedVersion: "0.12.2", digestMatch: false }] });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runDoctor({ vault: "/vault" })).toBe(0);
    expect(log.mock.calls.map(call => call[0])).toContain("Install assets: degraded (1 of 1 unusable).");
    expect(log.mock.calls.map(call => call[0])).toContain("  [PROVENANCE_MISMATCH] /skills packageVersion=0.12.3 recordedVersion=0.12.2 digestMatch=false — oms install --vault \"/vault\" --runtime hermes");
    expect(inspectInstalledAssets).toHaveBeenCalledWith(expect.objectContaining({ vault: "/vault", hosts: expect.any(Array), assets: expect.any(Array) }));
  });

  it("preserves provenance evidence in doctor JSON", async () => {
    vi.mocked(inspectInstalledAssets).mockResolvedValueOnce({ status: "degraded", hosts: [{ host: "hermes", state: "degraded" }], assets: [{ id: "hermes:0", kind: "skill-tree", declaredPath: "/skills", realPath: "/skills", state: "provenance-mismatch", cause: null, remediation: "oms install --vault \"/vault\" --runtime hermes", packageVersion: "0.12.3", recordedVersion: "0.12.2", digestMatch: false }] });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runDoctor({ vault: "/vault", json: true })).toBe(0);
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({ installAssets: { assets: [{ id: "hermes:0", packageVersion: "0.12.3", recordedVersion: "0.12.2", digestMatch: false }] } });
  });
});
