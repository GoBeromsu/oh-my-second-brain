import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectInstalledAssets, installRemediationCommand } from "./asset-health.js";

const roots: string[] = [];
const hosts = [{ host: "claude", state: "ok" as const }, { host: "hermes", state: "not-installed" as const }, { host: "codex", state: "not-installed" as const }];

async function inspect(declaredPath: string) {
  return inspectInstalledAssets({ assets: [{ id: "test", kind: "hook", declaredPath }] });
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("inspectInstalledAssets", () => {
  it("reports executable assets as ok", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-asset-health-")); roots.push(root);
    const guard = path.join(root, "oms-guard"); const postGuard = path.join(root, "oms-post-guard");
    await Promise.all([guard, postGuard].map(asset => writeFile(asset, "#!/usr/bin/env node\n")));
    await Promise.all([guard, postGuard].map(asset => chmod(asset, 0o755)));
    await expect(inspectInstalledAssets({ assets: [{ id: "guard", kind: "hook", host: "claude", declaredPath: guard }, { id: "post-guard", kind: "binary", host: "claude", declaredPath: postGuard }], hosts })).resolves.toMatchObject({ status: "ok", hosts, assets: [{ state: "ok", realPath: expect.any(String) }, { state: "ok", realPath: expect.any(String) }] });
  });
  it("names a dangling symlink instead of treating it as absent", async () => { const root = await mkdtemp(path.join(tmpdir(), "oms-asset-health-")); roots.push(root); const target = path.join(root, "deleted-target"); const asset = path.join(root, "oms-guard"); await writeFile(target, "#!/usr/bin/env node\n"); await symlink(target, asset); await unlink(target); const result = await inspect(asset); expect(result.assets[0]).toMatchObject({ state: "dangling-symlink", realPath: null }); });
  it("reports a present non-executable file", async () => { const root = await mkdtemp(path.join(tmpdir(), "oms-asset-health-")); roots.push(root); const asset = path.join(root, "oms-guard"); await writeFile(asset, "#!/usr/bin/env node\n"); await chmod(asset, 0o644); expect((await inspect(asset)).assets[0]).toMatchObject({ state: "not-executable", realPath: expect.any(String) }); });
  it("reports an absent declared path", async () => { const root = await mkdtemp(path.join(tmpdir(), "oms-asset-health-")); roots.push(root); expect((await inspect(path.join(root, "missing"))).assets[0]).toMatchObject({ state: "missing", realPath: null }); });
  it("reports a non-file hook path", async () => { const root = await mkdtemp(path.join(tmpdir(), "oms-asset-health-")); roots.push(root); expect((await inspect(root)).assets[0]).toMatchObject({ state: "not-a-file", realPath: expect.any(String) }); });
  it("reports a skill tree whose provenance does not match", async () => { const root = await mkdtemp(path.join(tmpdir(), "oms-asset-health-")); roots.push(root); const skillTree = path.join(root, "skills"); await writeFile(path.join(root, "provenance.json"), JSON.stringify({ schemaVersion: 1, source: "npm", version: "0.12.2", skillTreeDigest: "wrong", installedAt: "2026-01-01T00:00:00.000Z" })); await mkdir(skillTree); expect((await inspectInstalledAssets({ assets: [{ id: "skills", kind: "skill-tree", host: "hermes", declaredPath: skillTree, provenancePath: path.join(root, "provenance.json") }] })).assets[0]).toMatchObject({ state: "provenance-mismatch", realPath: expect.any(String) }); });
  it("reports a skill tree whose recorded version does not match", async () => { const root = await mkdtemp(path.join(tmpdir(), "oms-asset-health-")); roots.push(root); const skillTree = path.join(root, "skills"); await mkdir(skillTree); const { computeTreeDigest } = await import("./provenance.js"); await writeFile(path.join(root, "provenance.json"), JSON.stringify({ schemaVersion: 1, source: "npm", version: "0.12.2", skillTreeDigest: await computeTreeDigest(skillTree), installedAt: "2026-01-01T00:00:00.000Z" })); expect((await inspectInstalledAssets({ assets: [{ id: "skills", kind: "skill-tree", declaredPath: skillTree, provenancePath: path.join(root, "provenance.json"), provenanceVersion: "0.12.3" }] })).assets[0]).toMatchObject({ state: "provenance-mismatch", realPath: expect.any(String) }); });
  it("separates an uninstalled host from a degraded installed host", async () => { const root = await mkdtemp(path.join(tmpdir(), "oms-asset-health-")); roots.push(root); await expect(inspectInstalledAssets({ assets: [{ id: "claude-binary", kind: "binary", host: "claude", declaredPath: path.join(root, "missing") }], hosts })).resolves.toMatchObject({ status: "degraded", hosts: [{ host: "claude", state: "degraded" }, { host: "hermes", state: "not-installed" }, { host: "codex", state: "not-installed" }] }); });
  it("emits a runtime remediation command", () => { expect(installRemediationCommand("/vault", "claude")).toBe("oms install --vault \"/vault\" --runtime claude"); });
});
