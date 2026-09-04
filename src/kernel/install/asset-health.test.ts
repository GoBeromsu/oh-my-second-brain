import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectInstalledAssets } from "./asset-health.js";

const roots: string[] = [];

async function inspect(declaredPath: string) {
  return inspectInstalledAssets({
    assets: [{ id: "test", kind: "hook", declaredPath }],
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));

});

describe("inspectInstalledAssets", () => {
  it("reports executable assets as ok", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-asset-health-"));
    roots.push(root);
    const guard = path.join(root, "oms-guard");
    const postGuard = path.join(root, "oms-post-guard");
    await Promise.all([guard, postGuard].map(asset => writeFile(asset, "#!/usr/bin/env node\n")));
    await Promise.all([guard, postGuard].map(asset => chmod(asset, 0o755)));

    await expect(inspectInstalledAssets({
      assets: [
        { id: "guard", kind: "hook", declaredPath: guard },
        { id: "post-guard", kind: "binary", declaredPath: postGuard },
      ],
    })).resolves.toMatchObject({
      status: "ok",
      assets: [
        { state: "ok", realPath: expect.any(String) },
        { state: "ok", realPath: expect.any(String) },
      ],
    });
  });

  it("names a dangling symlink instead of treating it as absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-asset-health-"));
    roots.push(root);
    const target = path.join(root, "deleted-target");
    const asset = path.join(root, "oms-guard");
    await writeFile(target, "#!/usr/bin/env node\n");
    await symlink(target, asset);
    await unlink(target);

    const result = await inspect(asset);
    expect(result.assets[0]).toMatchObject({ state: "dangling-symlink", realPath: null });
    expect(result.assets[0]?.remediation.length).toBeGreaterThan(0);
  });

  it("reports a present non-executable file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-asset-health-"));
    roots.push(root);
    const asset = path.join(root, "oms-guard");
    await writeFile(asset, "#!/usr/bin/env node\n");
    await chmod(asset, 0o644);

    const result = await inspect(asset);
    expect(result.assets[0]).toMatchObject({ state: "not-executable", realPath: expect.any(String) });
    expect(result.assets[0]?.remediation.length).toBeGreaterThan(0);
  });

  it("reports an absent declared path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-asset-health-"));
    roots.push(root);

    const result = await inspect(path.join(root, "missing"));
    expect(result.assets[0]).toMatchObject({ state: "missing", realPath: null });
    expect(result.assets[0]?.remediation.length).toBeGreaterThan(0);
  });

  it("reports a non-file hook path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-asset-health-"));
    roots.push(root);

    const result = await inspect(root);
    expect(result.assets[0]).toMatchObject({ state: "not-a-file", realPath: expect.any(String) });
    expect(result.assets[0]?.remediation.length).toBeGreaterThan(0);
  });

  it("reports a skill tree whose provenance does not match", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-asset-health-"));
    roots.push(root);
    const skillTree = path.join(root, "skills");
    await writeFile(path.join(root, "provenance.json"), JSON.stringify({
      schemaVersion: 1,
      source: "npm",
      version: "0.12.2",
      skillTreeDigest: "wrong",
      installedAt: "2026-01-01T00:00:00.000Z",
    }));
    await mkdir(skillTree);

    const result = await inspectInstalledAssets({
      assets: [{ id: "skills", kind: "skill-tree", declaredPath: skillTree, provenancePath: path.join(root, "provenance.json") }],
    });
    expect(result.assets[0]).toMatchObject({ state: "provenance-mismatch", realPath: expect.any(String) });
    expect(result.assets[0]?.remediation.length).toBeGreaterThan(0);
  });

});
