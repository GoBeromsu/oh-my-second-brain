import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkMeasurementManifest,
  readShippedRankingPolicy,
  RELEASED_BASELINE_RANKING_POLICY,
} from "../scripts/check-measurement-manifest.mjs";
import { DEFAULT_DISPATCHER_POLICY } from "../src/kernel/engine/retrieval/dispatcher.js";
import { resolveEmbeddingModel } from "../src/kernel/engine/embed/model.js";
import { createNoDefaultContract } from "../src/kernel/measurement/no-default-contract.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const measurementCheckerPath = path.join(repoRoot, "scripts/check-measurement-manifest.mjs");

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

function temporaryDispatcher(policySource?: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "oms-measurement-gate-"));
  if (policySource !== undefined) {
    const dispatcherPath = path.join(directory, "src/kernel/engine/retrieval/dispatcher.ts");
    mkdirSync(path.dirname(dispatcherPath), { recursive: true });
    writeFileSync(dispatcherPath, policySource);
  }
  return directory;
}

function modelDefaultWaiver(): Record<string, unknown> {
  return {
    profile: "model-default",
    noDefault: true,
    reason: "Test-only contract fixture.",
    approvedBy: "test approver",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

const emptyInstalledModelsReceipt = {
  schemaVersion: 1 as const,
  artifacts: [],
  defaults: [],
};

function resolveWithoutInstalledModels(
  options: Parameters<typeof resolveEmbeddingModel>[0] = {},
) {
  return resolveEmbeddingModel({ ...options, installedReceipt: emptyInstalledModelsReceipt });
}

function noDefaultContract(overrides: Record<string, unknown> = {}) {
  return {
    resolveEmbeddingModel: resolveWithoutInstalledModels,
    installedReceiptExists: () => false,
    runMcp: () => undefined,
    fetch: () => undefined,
    ...overrides,
  };
}

/**
 * Measurement configuration is read from the process environment by design, so
 * these tests must not inherit it. CI sets `OMS_MEASUREMENT_*` at job scope,
 * which previously made the suite resolve a profile and trust anchors from the
 * ambient job instead of from the case under test.
 */
function isolateMeasurementEnv(): void {
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = {};
    for (const name of Object.keys(process.env)) {
      if (/^OMS_(MEASUREMENT|PREREG|GOLDEN)_/u.test(name)) {
        saved[name] = process.env[name];
        delete process.env[name];
      }
    }
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved = {};
  });
}

describe("R2 Phase D measurement gate", () => {
  isolateMeasurementEnv();

  it("makes the local release check required, attested, and artifact-supplied", async () => {
    const packageJson = JSON.parse(await readRepositoryFile("package.json")) as {
      scripts: Record<string, string>;
    };
    const command = packageJson.scripts["check:measurement"];

    expect(command).toContain("OMS_MEASUREMENT_REQUIRED=1");
    expect(command).toContain("OMS_MEASUREMENT_ATTESTATION_REQUIRED=1");
    expect(command).toContain("OMS_MEASUREMENT_RELEASE=1");
    expect(command).toContain("OMS_MEASUREMENT_PROFILE=boost-c040");
    expect(command).toContain("OMS_MEASUREMENT_MANIFEST=docs/measurements/boost-c040.json");
    expect(command).toContain("node scripts/check-measurement-manifest.mjs");
    expect(command).not.toContain("OMS_PREREG_QRELS_HASH=");
    expect(packageJson.scripts["release:check"]).toContain("npm run check:measurement");
  });

  it.each([".github/workflows/release.yml", ".github/workflows/ci.yml"])(
    "%s invokes an attested required measurement gate without a synthetic fixture",
    async (workflowPath) => {
      const workflow = await readRepositoryFile(workflowPath);

      expect(workflow).toContain('OMS_MEASUREMENT_REQUIRED: "1"');
      expect(workflow).toContain('OMS_MEASUREMENT_ATTESTATION_REQUIRED: "1"');
      expect(workflow).toContain('OMS_MEASUREMENT_RELEASE: "1"');
      expect(workflow).toContain('OMS_MEASUREMENT_PROFILE: "boost-c040"');
      expect(workflow).toContain('OMS_MEASUREMENT_MANIFEST: "docs/measurements/boost-c040.json"');
      expect(workflow).toContain("OMS_PREREG_QRELS_HASH:");
      expect(workflow).toContain("OMS_MEASUREMENT_MANIFEST:");
      expect(workflow).toContain("OMS_MEASUREMENT_TRUSTED_PUBLIC_KEY:");
      expect(workflow).toContain("npm run check:measurement");
    },
  );

  it("documents the release profile, exact manifest path, evidence gates, and computed winner", async () => {
    const measurementGuide = await readRepositoryFile("docs/measurements/README.md");
    const releaseGuide = await readRepositoryFile("docs/release.md");

    for (const guide of [measurementGuide, releaseGuide]) {
      expect(guide).toContain("boost-c040");
      expect(guide).toContain("docs/measurements/boost-c040.json");
      expect(guide).toContain("OMS_PREREG_QRELS_HASH");
      expect(guide).toContain("OMS_MEASUREMENT_TRUSTED_PUBLIC_KEY");
      expect(guide).toContain("attestation");
      expect(guide).toContain("paired raw evidence");
    }
    expect(measurementGuide).toContain("winnerArmId");
    expect(measurementGuide).toContain("checker calculates C040");
    expect(measurementGuide).toContain("boost-k-scale");
    expect(measurementGuide).toContain("boost-per-list");
    expect(measurementGuide).toContain("boost-zero");
    expect(releaseGuide).toContain("hard-coded winner");
  });

  it("fails closed against an absent temporary manifest rather than requiring a checked-in human artifact", () => {
    const directory = temporaryDispatcher(
      'export const DEFAULT_DISPATCHER_POLICY: DispatcherPolicy = "boost-k-scale";\n',
    );
    const missingPath = path.join(directory, "missing.json");
    try {
      expect(() => checkMeasurementManifest({
        required: true,
        profile: "boost-c040",
        manifestPath: missingPath,
        repoRoot: directory,
      })).toThrow(/could not read/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats empty measurement manifest and trust-anchor environment values as unset", () => {
    const previousManifest = process.env.OMS_MEASUREMENT_MANIFEST;
    const previousTrustedKey = process.env.OMS_MEASUREMENT_TRUSTED_PUBLIC_KEY;
    try {
      process.env.OMS_MEASUREMENT_MANIFEST = "";
      process.env.OMS_MEASUREMENT_TRUSTED_PUBLIC_KEY = "";

      expect(checkMeasurementManifest({ required: false })).toEqual({ present: false, advisory: true });
    } finally {
      if (previousManifest === undefined) delete process.env.OMS_MEASUREMENT_MANIFEST;
      else process.env.OMS_MEASUREMENT_MANIFEST = previousManifest;
      if (previousTrustedKey === undefined) delete process.env.OMS_MEASUREMENT_TRUSTED_PUBLIC_KEY;
      else process.env.OMS_MEASUREMENT_TRUSTED_PUBLIC_KEY = previousTrustedKey;
    }
  });

  it("does not require boost-c040 evidence when the shipped ranking policy is the released baseline", () => {
    const directory = temporaryDispatcher(
      'export const DEFAULT_DISPATCHER_POLICY: DispatcherPolicy = "boost-additive";\n',
    );
    try {
      const output = execFileSync(process.execPath, [measurementCheckerPath], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          OMS_MEASUREMENT_REQUIRED: "1",
          OMS_MEASUREMENT_PROFILE: "boost-c040",
        },
      });

      expect(output).toContain(
        "measurement gate: ranking default is the released baseline (boost-additive); boost-c040 manifest not applicable",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("still requires the boost-c040 manifest for a non-baseline ranking policy", () => {
    const directory = temporaryDispatcher(
      'export const DEFAULT_DISPATCHER_POLICY: DispatcherPolicy = "boost-k-scale";\n',
    );
    const manifestPath = path.join(directory, "docs/measurements/boost-c040.json");
    try {
      expect(() => checkMeasurementManifest({
        required: true,
        profile: "boost-c040",
        manifestPath,
        repoRoot: directory,
      })).toThrow(/could not read .*boost-c040\.json/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["absent", undefined],
    ["malformed", 'export const DEFAULT_DISPATCHER_POLICY = "boost-additive";\n'],
    ["duplicated", [
      'export const DEFAULT_DISPATCHER_POLICY: DispatcherPolicy = "boost-additive";',
      'export const DEFAULT_DISPATCHER_POLICY: DispatcherPolicy = "boost-additive";',
      "",
    ].join("\n")],
  ])("fails closed when the shipped ranking policy declaration is %s", (_case, source) => {
    const directory = temporaryDispatcher(source);
    try {
      expect(() => checkMeasurementManifest({
        required: true,
        profile: "boost-c040",
        repoRoot: directory,
      })).toThrow(/(could not read shipped ranking policy source|expected exactly one DEFAULT_DISPATCHER_POLICY declaration)/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the parsed shipped ranking policy aligned with the runtime default", () => {
    expect(DEFAULT_DISPATCHER_POLICY).toBe(RELEASED_BASELINE_RANKING_POLICY);
    expect(readShippedRankingPolicy(repoRoot)).toBe(DEFAULT_DISPATCHER_POLICY);
  });

  it("accepts a model-default waiver only after the production runtime no-default contract passes", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "oms-no-default-cache-"));
    try {
      await expect(checkMeasurementManifest({
      profile: "model-default",
      waiver: modelDefaultWaiver(),
      noDefaultContract: createNoDefaultContract({ cacheDir }),
      })).resolves.toMatchObject({ present: false, waived: true });
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("exercises the real no-model MCP paths with zero network calls", async () => {
    // The probe is only meaningful if it presses paths that actually depend on a
    // model: a plain lexical query must still succeed, and explicit vec/HyDE
    // must be refused loudly. Counting every fetch attempt proves the no-model
    // surface reaches no network at all.
    const cacheDir = mkdtempSync(path.join(tmpdir(), "oms-no-default-probe-"));
    let networkCalls = 0;
    const countedFetch = ((...args: unknown[]) => {
      networkCalls += 1;
      void args;
      return Promise.reject(new Error("network blocked during no-default probe"));
    }) as unknown as typeof globalThis.fetch;
    try {
      const contract = createNoDefaultContract({ cacheDir });
      await expect(contract.runMcp({ fetch: countedFetch, waiverActive: true }))
        .resolves.toBeUndefined();
      expect(networkCalls).toBe(0);
      expect(contract.installedReceiptExists()).toBe(false);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed when the waiver path introduces an installed-model receipt", async () => {
    await expect(checkMeasurementManifest({
      profile: "model-default",
      waiver: modelDefaultWaiver(),
      noDefaultContract: noDefaultContract({ installedReceiptExists: () => true }),
    })).rejects.toThrow(/no installed-model receipt is introduced/);
  });

  it("fails closed when explicit configuration diverges or a half pair is not loud", async () => {
    const divergentResolver = (options: {
      env: Record<string, string>;
      waiverActive?: boolean;
    }) => {
      if (options.env.OMS_EMBEDDING_PROVIDER && options.env.OMS_EMBEDDING_MODEL) {
        // Reports success for a model the caller never selected: the capability
        // resolver must never substitute a different provider for an explicit
        // environment selection.
        return {
          available: true,
          source: "environment",
          descriptor: {
            provider: "different-provider",
            model: options.env.OMS_EMBEDDING_MODEL,
          },
          equivalentSources: [],
          shadowedSources: [],
        };
      }
      return resolveWithoutInstalledModels(options);
    };
    await expect(checkMeasurementManifest({
      profile: "model-default",
      waiver: modelDefaultWaiver(),
      noDefaultContract: noDefaultContract({ resolveEmbeddingModel: divergentResolver }),
    })).rejects.toThrow(/explicit configuration behaviour is unchanged/);
  });

  it("fails closed when a waiver-path or MCP operation downloads", async () => {
    await expect(checkMeasurementManifest({
      profile: "model-default",
      waiver: modelDefaultWaiver(),
      noDefaultContract: noDefaultContract({
        runMcp: ({ fetch }: { fetch: (url: string) => unknown }) => fetch("https://example.invalid/model"),
      }),
    })).rejects.toThrow(/zero downloads/);
  });

  it("fails closed when an asynchronous MCP download resolves after its synchronous work", async () => {
    await expect(checkMeasurementManifest({
      profile: "model-default",
      waiver: modelDefaultWaiver(),
      noDefaultContract: noDefaultContract({
        runMcp: async ({ fetch }: { fetch: (url: string) => unknown }) => {
          await Promise.resolve();
          fetch("https://example.invalid/model");
        },
      }),
    })).rejects.toThrow(/zero downloads/);
  });

  it("fails closed when a half pair error omits either canonical variable", async () => {
    const incompleteResolver = (options: { env: Record<string, string> }) => {
      if (options.env.OMS_EMBEDDING_PROVIDER && !options.env.OMS_EMBEDDING_MODEL) {
        throw new Error("model missing");
      }
      return resolveWithoutInstalledModels(options);
    };
    await expect(checkMeasurementManifest({
      profile: "model-default",
      waiver: modelDefaultWaiver(),
      noDefaultContract: noDefaultContract({ resolveEmbeddingModel: incompleteResolver }),
    })).rejects.toThrow(/explicit configuration behaviour is unchanged/);
  });

  it("still rejects a boost-c040 waiver before accepting any runtime contract", () => {
    expect(() => checkMeasurementManifest({
      profile: "boost-c040",
      waiver: modelDefaultWaiver(),
      noDefaultContract: noDefaultContract(),
    })).toThrow(/boost-c040 is never waivable/);
  });
});
