import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HARNESS_HOST_REVIEWERS } from "../harness/surface-registry.js";
import {
  inspectInstalledAssets,
  inspectReviewerDefinitionAtRest,
  installRemediationCommand,
  reviewerDefinitionPackageRoot,
  type ReviewerDefinitionAtRest,
} from "./asset-health.js";
import { digestFileBytes, digestOneFile, serializeProvenance } from "./provenance.js";

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
  it("emits a final host-install remediation command", () => { expect(installRemediationCommand("/vault", "claude")).toBe("oms host install --runtime claude --vault \"/vault\""); });
  it("uses valid final flags for hostless remediation", async () => { const root = await mkdtemp(path.join(tmpdir(), "oms-asset-health-")); roots.push(root); expect((await inspectInstalledAssets({ assets: [{ id: "binary", kind: "binary", declaredPath: path.join(root, "missing") }], vault: "/vault" })).assets[0]?.remediation).toBe("oms host install --runtime auto --vault \"/vault\""); });
});

const REVIEWER_FILE = "oms-reviewer.toml";

function expectUnverified(receipt: ReviewerDefinitionAtRest): void {
  expect(receipt.independenceVerifiedByOms).toBe(false);
  expect(receipt.enforcementVerifiedByOms).toBe(false);
  expect(receipt.launchVerifiedByOms).toBe(false);
  expect(receipt.isolationLevel).toBe("instruction-only");
}

async function shippedCustomAgentBytes(): Promise<Buffer> {
  const assetPath = HARNESS_HOST_REVIEWERS.codex.find((mechanism) => mechanism.id === "codex.custom-agent")?.assetPath;
  if (assetPath !== "assets/codex/agents/oms-reviewer.toml") {
    throw new Error(`codex.custom-agent assetPath is ${String(assetPath)}`);
  }
  return readFile(path.join(reviewerDefinitionPackageRoot(), assetPath));
}

function provenanceRecord(bytes: Buffer, skillTreeDigest = digestOneFile(REVIEWER_FILE, bytes)): string {
  return serializeProvenance({
    schemaVersion: 1,
    source: "npm",
    version: "0.15.0",
    skillTreeDigest,
    installedAt: "2026-09-01T00:00:00.000Z",
  });
}

async function withCodexHome<T>(run: (root: string, codexDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "oms-reviewer-at-rest-"));
  roots.push(root);
  const codexDir = path.join(root, ".codex");
  const previous = process.env.OMS_CODEX_HOME;
  process.env.OMS_CODEX_HOME = codexDir;
  try {
    return await run(root, codexDir);
  } finally {
    if (previous === undefined) delete process.env.OMS_CODEX_HOME;
    else process.env.OMS_CODEX_HOME = previous;
  }
}

describe("reviewer definition at rest", () => {
  it("matches shipped bytes without treating sandbox_mode as tool-restricted", async () => {
    const source = await shippedCustomAgentBytes();
    expect(source.toString("utf8")).toContain('sandbox_mode = "read-only"');
    await withCodexHome(async (root, codexDir) => {
      const agents = path.join(codexDir, "agents");
      await mkdir(agents, { recursive: true });
      await writeFile(path.join(agents, REVIEWER_FILE), source);
      await writeFile(path.join(agents, "personal.toml"), "personal\n");
      await writeFile(path.join(agents, "oms-reviewer.provenance.json"), provenanceRecord(source));
      const receipt = await inspectReviewerDefinitionAtRest("codex.custom-agent", {
        homeDir: path.join(root, "decoy-home"),
      });
      expect(receipt).toMatchObject({
        mechanismId: "codex.custom-agent",
        disposition: "matched",
        definitionDigestVerifiedByOms: true,
        provenanceStatus: "match",
        cause: null,
        shippedBytesDigest: digestFileBytes(source),
        installedBytesDigest: digestFileBytes(source),
      });
      expect(receipt.shippedBytesDigest).not.toBe(digestOneFile(REVIEWER_FILE, source));
      expectUnverified(receipt);
      expect(existsSync(path.join(root, "decoy-home"))).toBe(false);
    });
  });

  it("reports installed bytes that differ from the shipped definition as drifted", async () => {
    const source = await shippedCustomAgentBytes();
    const drifted = Buffer.concat([source, Buffer.from("\n")]);
    await withCodexHome(async (root, codexDir) => {
      const agents = path.join(codexDir, "agents");
      await mkdir(agents, { recursive: true });
      await writeFile(path.join(agents, REVIEWER_FILE), drifted);
      await writeFile(path.join(agents, "oms-reviewer.provenance.json"), provenanceRecord(drifted));
      const receipt = await inspectReviewerDefinitionAtRest("codex.custom-agent", {
        homeDir: path.join(root, "decoy-home"),
      });
      expect(receipt).toMatchObject({
        disposition: "drifted",
        definitionDigestVerifiedByOms: false,
        provenanceStatus: "match",
        cause: "installed-bytes-differ",
        shippedBytesDigest: digestFileBytes(source),
        installedBytesDigest: digestFileBytes(drifted),
      });
      expect(receipt.shippedBytesDigest).not.toBe(receipt.installedBytesDigest);
      expectUnverified(receipt);
    });
  });

  it("reports a missing trusted install without reading a decoy path", async () => {
    const source = await shippedCustomAgentBytes();
    await withCodexHome(async (_root, codexDir) => {
      await mkdir(codexDir);
      await writeFile(path.join(codexDir, REVIEWER_FILE), source);
      const receipt = await inspectReviewerDefinitionAtRest("codex.custom-agent");
      expect(receipt).toMatchObject({
        disposition: "missing",
        definitionDigestVerifiedByOms: false,
        provenanceStatus: "not-applicable",
        installedBytesDigest: null,
        shippedBytesDigest: digestFileBytes(source),
        cause: null,
      });
      expect(existsSync(path.join(codexDir, "agents"))).toBe(false);
      expectUnverified(receipt);
      const health = await inspectInstalledAssets({
        assets: [{
          id: "reviewer",
          kind: "reviewer-definition",
          declaredPath: path.join(codexDir, "agents", REVIEWER_FILE),
          expectedShippedBytesDigest: digestFileBytes(source),
        }],
      });
      expect(health.assets[0]).toMatchObject({ state: "missing", cause: "ENOENT", realPath: null });
      expect(existsSync(path.join(codexDir, "agents"))).toBe(false);
    });
  });

  it("keeps byte identity when provenance is bad and keeps install health stricter", async () => {
    const source = await shippedCustomAgentBytes();
    await withCodexHome(async (_root, codexDir) => {
      const agents = path.join(codexDir, "agents");
      const role = path.join(agents, REVIEWER_FILE);
      const provenance = path.join(agents, "oms-reviewer.provenance.json");
      await mkdir(agents, { recursive: true });
      await writeFile(role, source);
      await chmod(role, 0o644);
      await writeFile(provenance, "{}\n");
      const invalid = await inspectReviewerDefinitionAtRest("codex.custom-agent");
      expect(invalid).toMatchObject({
        disposition: "matched",
        definitionDigestVerifiedByOms: true,
        provenanceStatus: "invalid",
        cause: null,
        shippedBytesDigest: digestFileBytes(source),
        installedBytesDigest: digestFileBytes(source),
      });
      expectUnverified(invalid);
      await writeFile(provenance, provenanceRecord(source, "0".repeat(64)));
      const mismatched = await inspectReviewerDefinitionAtRest("codex.custom-agent");
      expect(mismatched).toMatchObject({
        disposition: "matched",
        definitionDigestVerifiedByOms: true,
        provenanceStatus: "mismatch",
        cause: null,
      });
      expectUnverified(mismatched);
    });

    const root = await mkdtemp(path.join(tmpdir(), "oms-reviewer-health-"));
    roots.push(root);
    const role = path.join(root, REVIEWER_FILE);
    const provenance = path.join(root, "oms-reviewer.provenance.json");
    const bytes = Buffer.from("role\n");
    await writeFile(role, bytes);
    await chmod(role, 0o644);
    await writeFile(provenance, provenanceRecord(bytes));
    const declaration = {
      id: "reviewer",
      kind: "reviewer-definition" as const,
      declaredPath: role,
      provenancePath: provenance,
      expectedShippedBytesDigest: digestFileBytes(bytes),
      oneFileRelativeName: REVIEWER_FILE,
      provenanceVersion: "0.15.0",
    };
    expect((await inspectInstalledAssets({ assets: [declaration] })).assets[0]).toMatchObject({
      state: "ok",
      digestMatch: true,
      cause: null,
      realPath: role,
    });
    await writeFile(provenance, "{}\n");
    expect((await inspectInstalledAssets({ assets: [declaration] })).assets[0]).toMatchObject({
      state: "provenance-mismatch",
      digestMatch: false,
      cause: "invalid-provenance",
    });
    await writeFile(provenance, provenanceRecord(bytes, "0".repeat(64)));
    expect((await inspectInstalledAssets({ assets: [declaration] })).assets[0]).toMatchObject({
      state: "provenance-mismatch",
      digestMatch: false,
      cause: "provenance-digest-mismatch",
    });
    expect((await inspectInstalledAssets({
      assets: [{ ...declaration, expectedShippedBytesDigest: "0".repeat(64) }],
    })).assets[0]).toMatchObject({
      state: "provenance-mismatch",
      digestMatch: false,
      cause: "installed-bytes-differ",
    });
    const directory = path.join(root, "directory-definition");
    await mkdir(directory);
    expect((await inspectInstalledAssets({
      assets: [{ ...declaration, declaredPath: directory, provenancePath: undefined }],
    })).assets[0]).toMatchObject({ state: "not-a-file", cause: "not-a-file", realPath: null });
    expect((await inspectInstalledAssets({
      assets: [{ id: "reviewer", kind: "reviewer-definition", declaredPath: path.join(root, "absent.toml") }],
    })).assets[0]).toMatchObject({ state: "inspection-error", cause: "expected-shipped-bytes-digest-missing" });
  });

  it("reports an unreadable installed definition as unavailable", async () => {
    const source = await shippedCustomAgentBytes();
    await withCodexHome(async (_root, codexDir) => {
      const agents = path.join(codexDir, "agents");
      const role = path.join(agents, REVIEWER_FILE);
      await mkdir(agents, { recursive: true });
      await writeFile(role, source);
      await writeFile(path.join(agents, "oms-reviewer.provenance.json"), provenanceRecord(source));
      await chmod(role, 0o000);
      try {
        const receipt = await inspectReviewerDefinitionAtRest("codex.custom-agent");
        expect(receipt.disposition).toBe("unavailable");
        expect(["EACCES", "EPERM"]).toContain(receipt.cause);
        expect(receipt.definitionDigestVerifiedByOms).toBe(false);
        expect(receipt.installedBytesDigest).toBeNull();
        expectUnverified(receipt);
        const health = await inspectInstalledAssets({
          assets: [{
            id: "reviewer",
            kind: "reviewer-definition",
            declaredPath: role,
            expectedShippedBytesDigest: digestFileBytes(source),
            oneFileRelativeName: REVIEWER_FILE,
          }],
        });
        expect(health.assets[0]?.state).toBe("inspection-error");
        expect(["EACCES", "EPERM"]).toContain(health.assets[0]?.cause);
      } finally {
        await chmod(role, 0o644);
      }
    });
  });

  it("reports mechanisms with no shipped asset as not-applicable", async () => {
    await withCodexHome(async (_root, codexDir) => {
      for (const mechanismId of ["hermes.delegate-task", "codex.subagent"] as const) {
        const receipt = await inspectReviewerDefinitionAtRest(mechanismId);
        expect(receipt).toMatchObject({
          mechanismId,
          disposition: "not-applicable",
          provenanceStatus: "not-applicable",
          definitionDigestVerifiedByOms: false,
          shippedBytesDigest: null,
          installedBytesDigest: null,
          cause: null,
        });
        expectUnverified(receipt);
      }
      expect(existsSync(codexDir)).toBe(false);
    });
  });

  it("does not compare a shipped asset to itself when no trusted install path is declared", async () => {
    const packageRoot = await mkdtemp(path.join(tmpdir(), "oms-reviewer-empty-package-"));
    roots.push(packageRoot);
    const receipt = await inspectReviewerDefinitionAtRest("claude.plugin-agent", { packageRoot });
    expect(receipt).toMatchObject({
      mechanismId: "claude.plugin-agent",
      disposition: "unavailable",
      cause: "trusted-installed-path-not-declared",
      definitionDigestVerifiedByOms: false,
      shippedBytesDigest: null,
      installedBytesDigest: null,
    });
    expectUnverified(receipt);
  });

  it("uses the registry assetPath and rejects a blank package root", async () => {
    const source = await shippedCustomAgentBytes();
    await withCodexHome(async (root, codexDir) => {
      const packageRoot = path.join(root, "decoy-package");
      await mkdir(path.join(packageRoot, "agents"), { recursive: true });
      await writeFile(path.join(packageRoot, "agents", REVIEWER_FILE), source);
      await writeFile(path.join(packageRoot, REVIEWER_FILE), source);
      const missing = await inspectReviewerDefinitionAtRest("codex.custom-agent", {
        packageRoot,
        homeDir: path.join(root, "decoy-home"),
      });
      expect(missing).toMatchObject({
        disposition: "unavailable",
        cause: "shipped-source-missing",
        definitionDigestVerifiedByOms: false,
      });
      expect(existsSync(path.join(codexDir, "agents"))).toBe(false);
      expectUnverified(missing);
      const blank = await inspectReviewerDefinitionAtRest("codex.custom-agent", { packageRoot: "" });
      expect(blank).toMatchObject({ disposition: "unavailable", cause: "invalid-package-root" });
      expectUnverified(blank);
    });
  });

  it("does not follow a symlink to bytes that match the shipped definition", async () => {
    const source = await shippedCustomAgentBytes();
    await withCodexHome(async (root, codexDir) => {
      const outside = path.join(root, "outside.toml");
      const agents = path.join(codexDir, "agents");
      const role = path.join(agents, REVIEWER_FILE);
      await writeFile(outside, source);
      await mkdir(agents, { recursive: true });
      await symlink(outside, role);
      await writeFile(path.join(agents, "oms-reviewer.provenance.json"), provenanceRecord(source));
      const receipt = await inspectReviewerDefinitionAtRest("codex.custom-agent");
      expect(receipt).toMatchObject({
        disposition: "unavailable",
        cause: "symlink",
        definitionDigestVerifiedByOms: false,
        installedBytesDigest: null,
        shippedBytesDigest: digestFileBytes(source),
      });
      expectUnverified(receipt);
      const health = await inspectInstalledAssets({
        assets: [{
          id: "reviewer",
          kind: "reviewer-definition",
          declaredPath: role,
          expectedShippedBytesDigest: digestFileBytes(source),
          oneFileRelativeName: REVIEWER_FILE,
        }],
      });
      expect(health.assets[0]).toMatchObject({ state: "inspection-error", cause: "symlink", realPath: null });
    });
  });
});
