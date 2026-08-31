/**
 * Standalone golden-set parity runner.
 *
 * Bypasses golden.test.ts deliberately to avoid:
 *   (1) the test(c) / OMS_GOLDEN_QUERIES process-wide conflict, and
 *   (2) the 300s timeout that a full per-query re-embed would blow.
 *
 * Uses the SAME harness instrument; emits OMS_GOLDEN_REPORT for an independent
 * verification pass. Run via:
 *   OMS_GOLDEN_QUERIES=… OMS_VAULT=… OMS_EMBEDDING_PROVIDER=… OMS_EMBEDDING_MODEL=… OMS_GOLDEN_DB=… \
 *   OMS_ENGINE_CACHE=… OMS_SLICE_MANIFEST=… OMS_GOLDEN_REPORT=… \
 *   npx vitest run test/golden-set/parity-run.test.ts
 *
 * To turn measurements into the gated paired outcome, supply
 * OMS_PARITY_PREREGISTRATION, OMS_PARITY_OUTCOME, OMS_PARITY_RAW_RESULTS,
 * OMS_QMD_ROOT, OMS_QMD_INDEX, OMS_QMD_CONFIG, and OMS_QMD_MODEL_CACHE
 * (plus the query/qrels/db variables above).
 * The runner invokes qmd, runs and measures OMS sync/query itself, and computes
 * paired metrics/digests; it never trusts a caller-supplied verdict bundle.
 * OMS_PARITY_ASSERT_REPLACEMENT=1 adds the B2-only claim assertion after raw
 * evidence and the outcome have been persisted.
 *
 * **What this does and does not produce.** Without the complete paired variables
 * it emits only an OMS harness report; `overallPass` remains the R2 recall-floor
 * result and is not a parity verdict. With the complete paired variables it
 * invokes the exact comparator, persists raw paired rows, measures OMS
 * operability, evaluates the frozen gate, and enforces the stop policy.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  loadGoldenQueries,
  loadQrels,
  printHarnessReport,
  runHarness,
} from "./harness.js";
import { checkPreflight, formatPreflightReport } from "./parity-preflight.js";
import {
  evaluateAuditedParityOutcome,
  serializeAuditedParityOutcome,
  validatePriorB1Record,
} from "./parity-outcome.js";
import {
  assertReleasePermitted,
  assertReplacementClaimPermitted,
} from "./parity-stop-policy.js";
import {
  buildPairedRelevance,
  assertQmdModelSetIdentity,
  assertRawEvidenceSeal,
  pairParityRows,
  parityRawEvidenceDigest,
  parityQueriesSha256,
  prepareQmdComparator,
  runQmdComparatorArm,
  type PairedParityRow,
} from "./parity-comparator.js";
import {
  expectedModalitiesForProfile,
} from "./parity-outcome.js";
import {
  qrelsSha256,
  type Qrels,
} from "./harness.js";
import type {
  ParityModality,
} from "./parity-gate.js";
import type {
  FrozenSettings,
  ParityPreregistration,
} from "./parity-preregistration.js";
import {
  evaluateAdmissibility,
  PINNED_QMD_COMMIT,
} from "./parity-preregistration.js";
import { runOmsMeasuredParityArm } from "./parity-oms-run.js";
import { assembleEngine } from "../../src/kernel/engine/assemble.js";
import {
  readInstalledModelsReceiptSync,
  resolveEmbeddingModel,
  type InstalledModelsReceipt,
} from "../../src/kernel/engine/embed/model.js";
import {
  resolveModelCapability,
  type PortableModelSelection,
} from "../../src/kernel/engine/embed/config.js";
import { snapshotCorpus } from "./parity-corpus.js";
import { loadTaxonomyIntentProjection } from "../../src/kernel/engine/retrieval/taxonomy-context.js";

/** Read the installed comparator version, or undefined when absent. */
function installedComparatorVersion(): string | undefined {
  try {
    const root = process.env["OMS_QMD_ROOT"];
    const executable = root === undefined ? "qmd" : path.join(root, "bin", "qmd");
    return execFileSync(executable, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function installedComparatorCommit(): string | undefined {
  const root = process.env["OMS_QMD_ROOT"];
  if (root === undefined || root.trim() === "") return undefined;
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export const PAIRED_PARITY_ENV = [
  "OMS_PARITY_PREREGISTRATION",
  "OMS_PARITY_OUTCOME",
  "OMS_PARITY_RAW_RESULTS",
  "OMS_QMD_ROOT",
  "OMS_QMD_INDEX",
  "OMS_QMD_CONFIG",
  "OMS_QMD_MODEL_CACHE",
  "OMS_QMD_COLLECTION",
  "OMS_GOLDEN_QUERIES",
  "OMS_GOLDEN_QRELS",
  "OMS_GOLDEN_DB",
] as const;

export function pairedParityEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): { readonly requested: boolean; readonly missing: readonly string[] } {
  const supplied = PAIRED_PARITY_ENV.filter((name) => env[name] !== undefined);
  const requested = supplied.length > 0;
  const missing = requested
    ? PAIRED_PARITY_ENV.filter((name) => {
      const value = env[name];
      return value === undefined || value.trim() === "";
    })
    : [];
  return { requested, missing };
}

function precisionModelRequests(
  settings: FrozenSettings,
): Readonly<Partial<Record<"rerank" | "generate", PortableModelSelection>>> {
  return {
    ...(settings.rerank ? {
      rerank: {
        provider: "gguf" as const,
        model: settings.rerankModel!,
        revision: settings.rerankRevision!,
        sha256: settings.rerankSha256!.replace(/^sha256:/iu, "").toLowerCase(),
      },
    } : {}),
    ...(settings.expansion ? {
      generate: {
        provider: "gguf" as const,
        model: settings.generateModel!,
        revision: settings.generateRevision!,
        sha256: settings.generateSha256!.replace(/^sha256:/iu, "").toLowerCase(),
        promptScheme: settings.generatePromptScheme!,
      },
    } : {}),
  };
}

function installedPrecisionIdentity(
  settings: FrozenSettings,
  receipt: InstalledModelsReceipt = readInstalledModelsReceiptSync(),
): {
  readonly rerank?: {
    readonly model: string;
    readonly revision: string;
    readonly sha256: string;
  };
  readonly generate?: {
    readonly model: string;
    readonly revision: string;
    readonly sha256: string;
    readonly promptScheme?: string;
  };
} {
  const requests = precisionModelRequests(settings);
  const resolve = (capability: "rerank" | "generate") => {
    const request = requests[capability];
    if (request === undefined) return undefined;
    const resolution = resolveModelCapability({
      capability,
      request,
      env: {},
      vaultConfig: null,
      installedArtifacts: receipt.artifacts,
      setupDefaults: receipt.defaults,
    });
    if (!resolution.available || resolution.artifact === undefined) {
      throw new Error(
        `installed OMS ${capability} identity does not match preregistration: ` +
          `${resolution.reason ?? resolution.guidance ?? "unavailable"}`,
      );
    }
    return resolution.artifact;
  };
  const rerank = resolve("rerank");
  const generate = resolve("generate");
  return {
    ...(rerank === undefined ? {} : {
      rerank: {
        model: rerank.selection.model,
        revision: rerank.selection.revision,
        sha256: rerank.selection.sha256,
      },
    }),
    ...(generate === undefined ? {} : {
      generate: {
        model: generate.selection.model,
        revision: generate.selection.revision,
        sha256: generate.selection.sha256,
        ...(generate.selection.promptScheme === undefined
          ? {}
          : { promptScheme: generate.selection.promptScheme }),
      },
    }),
  };
}

export function assertPriorB1RawBindings(
  record: ReturnType<typeof evaluateAuditedParityOutcome>,
  raw: Readonly<Record<string, unknown>>,
  qrels: Qrels,
): void {
  assertRawEvidenceSeal(raw, record.observedEvidence.rawResultsDigest);
  const rows = raw["rows"];
  const operability = raw["omsOperability"];
  if (!Array.isArray(rows)) throw new Error("B1 raw evidence has no paired rows");
  const recomputedRelevance = buildPairedRelevance(
    rows as PairedParityRow[],
    qrels,
    ["lex", "vec"],
  );
  if (
    JSON.stringify(recomputedRelevance)
      !== JSON.stringify(record.relevanceMeasurement)
  ) {
    throw new Error("B1 relevance measurement does not match sealed raw rows");
  }
  if (
    JSON.stringify(operability)
      !== JSON.stringify(record.operabilityMeasurement)
  ) {
    throw new Error("B1 operability measurement does not match sealed raw evidence");
  }
}

describe("golden parity runner", () => {
  // Standalone manual runner: skipped in the bare `npm test` gate (no env),
  // runs only when invoked with OMS_VAULT + the sibling OMS_* env vars.
  it.skipIf(!process.env["OMS_VAULT"])(
    "runs full parity and emits report",
    async () => {
      const vaultPath = process.env["OMS_VAULT"];
      if (!vaultPath) throw new Error("OMS_VAULT required");
      const preregistrationPath = process.env["OMS_PARITY_PREREGISTRATION"];
      const declaredPreregistration = preregistrationPath === undefined
        ? undefined
        : JSON.parse(readFileSync(preregistrationPath, "utf8")) as ParityPreregistration;
      const paired = pairedParityEnvironment(process.env);
      const pairedRequested = paired.requested;
      if (paired.missing.length > 0) {
        throw new Error(
          `paired parity run is missing required variables: ${paired.missing.join(", ")}`,
        );
      }
      if (pairedRequested) {
        const declared = evaluateAdmissibility(declaredPreregistration!);
        if (!declared.admissible) {
          throw new Error(
            `paired parity preregistration is inadmissible:\n${declared.failures.join("\n")}`,
          );
        }
      }
      const loadedQueries = declaredPreregistration === undefined
        ? undefined
        : loadGoldenQueries();
      const loadedQrels = loadedQueries === undefined
        ? undefined
        : loadQrels(loadedQueries);
      const parityQueries = loadedQueries?.filter(
        (query): query is typeof query & { readonly type: ParityModality } =>
          query.type === "lex" || query.type === "vec" || query.type === "hyde",
      );
      if (
        paired.requested
        && loadedQueries !== undefined
        && parityQueries?.length !== loadedQueries.length
      ) {
        throw new Error("paired parity query set may contain only lex, vec, and hyde rows");
      }
      const observedQueriesSha256 = parityQueries === undefined
        ? undefined
        : parityQueriesSha256(parityQueries);
      const observedQrelsSha256 = loadedQrels === undefined
        ? undefined
        : qrelsSha256(loadedQrels);

      // Readiness first. A six-hour embed that turns out to be inadmissible —
      // wrong comparator build, missing labels, or an environment variable trying
      // to move a frozen threshold — is worse than a refusal up front.
      const preflight = await checkPreflight({
        vaultPath,
        installedComparatorVersion: installedComparatorVersion(),
        installedComparatorCommit: installedComparatorCommit(),
        expectedCorpusDigest: declaredPreregistration?.corpusDigest,
        expectedCorpusFileCount: declaredPreregistration?.corpusFileCount,
        expectedQueriesSha256: declaredPreregistration?.queriesSha256,
        observedQueriesSha256,
        expectedQrelsSha256: declaredPreregistration?.qrelsSha256,
        observedQrelsSha256,
        queriesSupplied: process.env["OMS_GOLDEN_QUERIES"] !== undefined,
        qrelsSupplied: process.env["OMS_GOLDEN_QRELS"] !== undefined,
      });
      console.log(formatPreflightReport(preflight));
      if (pairedRequested && !preflight.ready) {
        throw new Error(
          `paired parity preflight is blocked:\n${preflight.blockers
            .map((blocker) => `  - ${blocker.id}: ${blocker.detail}`)
            .join("\n")}`,
        );
      }
      const qmdModelCacheDir = process.env["OMS_QMD_MODEL_CACHE"];
      if (
        pairedRequested
        && (
          qmdModelCacheDir === undefined
          || path.basename(qmdModelCacheDir) !== "models"
          || path.basename(path.dirname(qmdModelCacheDir)) !== "qmd"
        )
      ) {
        throw new Error("OMS_QMD_MODEL_CACHE must be an XDG <cache>/qmd/models directory");
      }
      const qmdCacheRoot = qmdModelCacheDir === undefined
        ? undefined
        : path.dirname(path.dirname(qmdModelCacheDir));
      const qmdEnv = pairedRequested
        ? {
          QMD_CONFIG_DIR: path.dirname(process.env["OMS_QMD_CONFIG"]!),
          XDG_CACHE_HOME: qmdCacheRoot,
        }
        : undefined;
      const installedReceiptBefore = pairedRequested
        ? readInstalledModelsReceiptSync()
        : undefined;
      const omsPrecisionBefore = pairedRequested
        ? installedPrecisionIdentity(
          declaredPreregistration!.settings,
          installedReceiptBefore!,
        )
        : undefined;
      const qmdIdentityBefore = pairedRequested
        ? await assertQmdModelSetIdentity(declaredPreregistration!.settings, {
          configPath: process.env["OMS_QMD_CONFIG"]!,
          modelCacheDir: process.env["OMS_QMD_MODEL_CACHE"]!,
        })
        : undefined;
      const qmdCorpusSnapshot = pairedRequested
        ? await snapshotCorpus(vaultPath)
        : undefined;
      if (
        pairedRequested
        && (
          qmdCorpusSnapshot?.digest !== preflight.corpusDigest
          || qmdCorpusSnapshot.fileCount !== preflight.corpusFileCount
        )
      ) {
        throw new Error("frozen corpus drifted between preflight and qmd preparation");
      }
      const taxonomyProjection = qmdCorpusSnapshot === undefined
        ? undefined
        : await loadTaxonomyIntentProjection(
          vaultPath,
          qmdCorpusSnapshot.entries.map((entry) => entry.relativePath),
        );
      let priorB1Record: ReturnType<typeof evaluateAuditedParityOutcome> | undefined;
      if (pairedRequested && declaredPreregistration!.profile === "b2-parity") {
        const priorOutcomePath = process.env["OMS_PARITY_B1_OUTCOME"];
        const priorRawPath = process.env["OMS_PARITY_B1_RAW_RESULTS"];
        if (
          priorOutcomePath === undefined
          || priorOutcomePath.trim() === ""
          || priorRawPath === undefined
          || priorRawPath.trim() === ""
        ) {
          throw new Error(
            "B2 requires OMS_PARITY_B1_OUTCOME and OMS_PARITY_B1_RAW_RESULTS",
          );
        }
        priorB1Record = JSON.parse(
          readFileSync(priorOutcomePath, "utf8"),
        ) as ReturnType<typeof evaluateAuditedParityOutcome>;
        const priorRaw = JSON.parse(
          readFileSync(priorRawPath, "utf8"),
        ) as Record<string, unknown>;
        assertPriorB1RawBindings(priorB1Record, priorRaw, loadedQrels!);
        const priorFailures = validatePriorB1Record(
          declaredPreregistration!,
          priorB1Record,
        );
        if (priorFailures.length > 0) {
          throw new Error(`B2 admission denied:\n${priorFailures.join("\n")}`);
        }
      }
      const qmdPreparation = pairedRequested
        ? await prepareQmdComparator({
          root: process.env["OMS_QMD_ROOT"]!,
          index: process.env["OMS_QMD_INDEX"]!,
          collection: process.env["OMS_QMD_COLLECTION"]!,
          vaultPath,
          configPath: process.env["OMS_QMD_CONFIG"]!,
          env: qmdEnv,
        }, declaredPreregistration!.corpusFileCount, {
          ...(taxonomyProjection?.promptContext === undefined
            ? {}
            : { globalContext: taxonomyProjection.promptContext }),
          pathContexts: Object.fromEntries(
            (taxonomyProjection?.matched ?? []).map(({ folder, intent }) => [
              `/${folder}`,
              intent,
            ]),
          ),
        })
        : undefined;
      const manPath = process.env["OMS_SLICE_MANIFEST"];
      const files = manPath
        ? (JSON.parse(readFileSync(manPath, "utf8")) as string[])
        : undefined;

      const cacheDir = process.env["OMS_ENGINE_CACHE"];

      const report = await runHarness({
        vaultPath,
        ...(loadedQueries === undefined ? {} : { queries: loadedQueries }),
        ...(loadedQrels === undefined ? {} : { qrels: loadedQrels }),
        ...(declaredPreregistration === undefined
          ? {}
          : { qrelsHash: declaredPreregistration.qrelsSha256 }),
        files,
        dbPath: process.env["OMS_GOLDEN_DB"],
        configOverrides: cacheDir ? { cacheDir } : {},
      });

      printHarnessReport(report);
      // Labelled so this line cannot be read as the frozen parity gate's verdict.
      console.log("[parity-run] harness overallPass=" + report.overallPass);
      console.log(
        pairedRequested
          ? "[parity-run] harness overallPass is diagnostic only; paired gate evaluation follows."
          : "[parity-run] NOT a parity verdict: paired comparator variables were not supplied.",
      );

      if (!preflight.ready) {
        const owner = preflight.blockers.filter((entry) => entry.humanOnly);
        console.log(
          `[parity-run] parity remains blocked by ${preflight.blockers.length} precondition(s); ` +
            `${owner.length} require the vault owner.`,
        );
      }

      // The paired verdict is generated from this run's OMS rows plus direct
      // invocations of the exact pinned qmd checkout. No caller-supplied metrics
      // bundle is trusted.
      if (pairedRequested) {
        const preregistration = declaredPreregistration!;
        const qrels = loadedQrels!;
        const expectedModalities = expectedModalitiesForProfile(
          preregistration.profile,
        ) as readonly ParityModality[];
        const embedding = resolveEmbeddingModel();
        if (embedding.descriptor === undefined) {
          throw new Error("paired parity requires a verified installed OMS embedding descriptor");
        }
        const descriptor = embedding.descriptor;
        const configured = preregistration.settings;
        if (
          descriptor.model !== configured.embedModel
          || descriptor.revision !== configured.embedRevision
          || descriptor.sha256 !== configured.embedSha256
            .replace(/^sha256:/iu, "")
            .toLowerCase()
          || descriptor.prefixScheme !== configured.embedPromptScheme
        ) {
          throw new Error(
            "installed OMS embedding identity does not match the preregistered " +
              "model/revision/checksum/prompt scheme",
          );
        }
        const omsEngine = assembleEngine({
          vault: vaultPath,
          dbPath: process.env["OMS_GOLDEN_DB"]!,
          embeddingDescriptor: descriptor,
          installedModelsReceipt: installedReceiptBefore!,
          modelRequests: precisionModelRequests(preregistration.settings),
          modelEnv: {},
          modelsConfig: null,
        });
        let measuredOms;
        try {
          measuredOms = await runOmsMeasuredParityArm({
            engine: omsEngine,
            queries: report.queries,
            settings: preregistration.settings,
            dbPath: process.env["OMS_GOLDEN_DB"]!,
            files,
          });
        } finally {
          await omsEngine.dispose();
        }
        const omsRows = measuredOms.rows;
        const qmdRows = runQmdComparatorArm(
          report.queries,
          preregistration.settings,
          {
            root: process.env["OMS_QMD_ROOT"]!,
            index: process.env["OMS_QMD_INDEX"]!,
            vaultPath,
            collection: process.env["OMS_QMD_COLLECTION"]!,
            env: qmdEnv,
          },
        );
        const pairedRows = pairParityRows(omsRows, qmdRows, expectedModalities);
        let qmdIdentityAfter;
        let qmdIdentityError: string | undefined;
        try {
          qmdIdentityAfter = await assertQmdModelSetIdentity(
            preregistration.settings,
            {
              configPath: process.env["OMS_QMD_CONFIG"]!,
              modelCacheDir: process.env["OMS_QMD_MODEL_CACHE"]!,
            },
          );
        } catch (error) {
          qmdIdentityError = error instanceof Error ? error.message : String(error);
        }
        const corpusAfter = await snapshotCorpus(vaultPath);
        const allQueriesAfter = loadGoldenQueries();
        const queriesAfter = allQueriesAfter.filter(
          (query): query is typeof query & { readonly type: ParityModality } =>
            query.type === "lex" || query.type === "vec" || query.type === "hyde",
        );
        const queriesAfterSha256 = queriesAfter.length === allQueriesAfter.length
          ? parityQueriesSha256(queriesAfter)
          : "invalid-non-parity-modality";
        const qrelsAfter = loadQrels(allQueriesAfter);
        const embeddingAfter = resolveEmbeddingModel().descriptor;
        let omsPrecisionAfter;
        let omsPrecisionError: string | undefined;
        try {
          omsPrecisionAfter = installedPrecisionIdentity(preregistration.settings);
        } catch (error) {
          omsPrecisionError = error instanceof Error ? error.message : String(error);
        }
        const rawEvidenceCore = {
          schema: "oms.paired-parity-raw.v1",
          baselineCommit: preregistration.baselineCommit,
          corpusBefore: {
            digest: preflight.corpusDigest,
            fileCount: preflight.corpusFileCount,
          },
          corpusAfter: {
            digest: corpusAfter.digest,
            fileCount: corpusAfter.fileCount,
          },
          qmdEmbeddingBefore: qmdIdentityBefore,
          qmdEmbeddingAfter: qmdIdentityAfter,
          ...(qmdIdentityError === undefined ? {} : { qmdIdentityError }),
          omsPrecisionBefore,
          omsPrecisionAfter,
          ...(omsPrecisionError === undefined ? {} : { omsPrecisionError }),
          qmdPreparation,
          omsOperability: measuredOms.operability,
          omsSync: measuredOms.sync,
          rows: pairedRows,
        };
        const rawResultsDigest = parityRawEvidenceDigest(rawEvidenceCore);
        const rawEvidenceRecord = {
          ...rawEvidenceCore,
          rawResultsDigest,
        };
        assertRawEvidenceSeal(rawEvidenceRecord);
        // Raw evidence is persisted before any assertion. A failing or drifting
        // arm therefore leaves the exact rows that caused the stop decision.
        writeFileSync(
          process.env["OMS_PARITY_RAW_RESULTS"]!,
          `${JSON.stringify(rawEvidenceRecord, null, 2)}\n`,
          "utf8",
        );
        const audited = evaluateAuditedParityOutcome({
          preregistration,
          observedEvidence: {
            baselineCommit: PINNED_QMD_COMMIT,
            corpusDigest: corpusAfter.digest,
            corpusFileCount: corpusAfter.fileCount,
            queriesSha256: queriesAfterSha256,
            qrelsSha256: qrelsSha256(qrelsAfter),
            rawResultsDigest,
            queryCount: allQueriesAfter.length,
            embedModel: embeddingAfter?.model ?? "unavailable",
            embedRevision: embeddingAfter?.revision ?? "unavailable",
            embedSha256: embeddingAfter?.sha256 ?? "unavailable",
            embedPromptScheme: embeddingAfter?.prefixScheme ?? "unavailable",
            qmdEmbedUri: qmdIdentityAfter?.embed.uri ?? "unavailable",
            ...(preregistration.settings.rerank ? {
              rerankModel: omsPrecisionAfter?.rerank?.model ?? "unavailable",
              rerankRevision: omsPrecisionAfter?.rerank?.revision ?? "unavailable",
              rerankSha256: omsPrecisionAfter?.rerank?.sha256 ?? "unavailable",
              qmdRerankUri: qmdIdentityAfter?.rerank?.uri ?? "unavailable",
            } : {}),
            ...(preregistration.settings.expansion ? {
              generateModel: omsPrecisionAfter?.generate?.model ?? "unavailable",
              generateRevision: omsPrecisionAfter?.generate?.revision ?? "unavailable",
              generateSha256: omsPrecisionAfter?.generate?.sha256 ?? "unavailable",
              generatePromptScheme:
                omsPrecisionAfter?.generate?.promptScheme ?? "unavailable",
              qmdGenerateUri: qmdIdentityAfter?.generate?.uri ?? "unavailable",
            } : {}),
          },
          relevance: buildPairedRelevance(pairedRows, qrels, expectedModalities),
          operability: measuredOms.operability,
          env: process.env,
          ...(priorB1Record === undefined ? {} : { priorB1Record }),
        });
        const outcomePath = process.env["OMS_PARITY_OUTCOME"]!;
        writeFileSync(outcomePath, serializeAuditedParityOutcome(audited), "utf8");
        console.log(
          `[parity-run] audited outcome ${audited.outcome.passed ? "PASS" : "FAIL"} ` +
            `written to ${outcomePath}`,
        );
        // Preserve first, enforce second: a miss must leave its raw evidence and
        // stop-policy receipt behind before the test exits non-zero.
        assertReleasePermitted(audited.outcome);
        if (process.env["OMS_PARITY_ASSERT_REPLACEMENT"] === "1") {
          assertReplacementClaimPermitted(audited.outcome);
        }
      }

      // The report must be internally consistent whether or not parity is
      // reachable: every declared query produces a row, and MRR is emitted
      // alongside recall and nDCG so the frozen gate's three metrics all exist.
      expect(report.queries.length).toBeGreaterThan(0);
      expect(Number.isFinite(report.metrics.mrrAt10.mean)).toBe(true);
    },
    3_600_000,
  );

  it("states its own preflight contract without needing a vault", async () => {
    // Runs in the ordinary suite: proves the runner's readiness check is wired and
    // reports owner-only blockers rather than being a comment about intent.
    const preflight = await checkPreflight({
      vaultPath: "/nonexistent-vault-for-contract-check",
      installedComparatorVersion: installedComparatorVersion(),
      installedComparatorCommit: installedComparatorCommit(),
      queriesSupplied: false,
      qrelsSupplied: false,
      snapshot: async () => {
        throw new Error("ENOENT: no such vault");
      },
    });

    expect(preflight.ready).toBe(false);
    const text = formatPreflightReport(preflight);
    expect(text).toMatch(/^parity preflight: BLOCKED/u);
    expect(text).toMatch(/\[USER\] qrels-supplied/);
    // Labels are the owner's judgement; the runner must never imply otherwise.
    expect(text).toMatch(/never inferred/);
  });

  it("requires the complete paired environment or none of it", () => {
    expect(pairedParityEnvironment({})).toEqual({ requested: false, missing: [] });
    expect(pairedParityEnvironment({
      OMS_PARITY_OUTCOME: "/tmp/out.json",
    })).toEqual({
      requested: true,
      missing: PAIRED_PARITY_ENV.filter((name) => name !== "OMS_PARITY_OUTCOME"),
    });
    expect(pairedParityEnvironment(Object.fromEntries(
      PAIRED_PARITY_ENV.map((name) => [name, `/tmp/${name}`]),
    ))).toEqual({ requested: true, missing: [] });
  });

  it("recomputes preserved B1 metrics from its sealed raw rows", () => {
    const rows: PairedParityRow[] = [{
      id: "lex-1",
      type: "lex",
      queryClass: "ko",
      query: "평온",
      oms: {
        hits: [{ path: "notes/calm.md", score: 1 }],
        latencyMs: 10,
      },
      qmd: {
        hits: [{ path: "notes/calm.md", score: 1 }],
        latencyMs: 11,
      },
    }];
    const qrels: Qrels = { "lex-1": { "notes/calm.md": 3 } };
    const relevance = buildPairedRelevance(rows, qrels, ["lex", "vec"]);
    const operability = {
      exitCode: 0,
      scanned: 1,
      indexed: 1,
      skipped: 0,
      errors: 0,
      vectorCount: 1,
      expectedVectorCount: 1,
      peakRssBytes: 1024,
      embedWallMs: 10,
      plainQueryP95Ms: 10,
    };
    const core = { rows, omsOperability: operability };
    const rawResultsDigest = parityRawEvidenceDigest(core);
    const raw = { ...core, rawResultsDigest };
    const record = {
      observedEvidence: { rawResultsDigest },
      relevanceMeasurement: relevance,
      operabilityMeasurement: operability,
    } as ReturnType<typeof evaluateAuditedParityOutcome>;

    expect(() => assertPriorB1RawBindings(record, raw, qrels)).not.toThrow();
    expect(() => assertPriorB1RawBindings({
      ...record,
      relevanceMeasurement: {
        ...relevance,
        aggregate: { ...relevance.aggregate, scoredRows: 0 },
      },
    }, raw, qrels)).toThrow(/relevance measurement/);
  });

  it("resolves the preregistered precision identity instead of the first receipt artifact", () => {
    const settings: FrozenSettings = {
      candidateLimit: 40,
      k: 10,
      rrfK: 60,
      rerank: true,
      expansion: true,
      embedModel: "embed.gguf",
      embedRevision: "embed-revision",
      embedSha256: "e".repeat(64),
      embedPromptScheme: "qwen3-embedding-v1",
      qmdEmbedUri: "hf:example/embed.gguf",
      rerankModel: "wanted-rerank.gguf",
      rerankRevision: "wanted-rerank-revision",
      rerankSha256: "1".repeat(64),
      qmdRerankUri: "hf:example/wanted-rerank.gguf",
      generateModel: "wanted-generate.gguf",
      generateRevision: "wanted-generate-revision",
      generateSha256: "2".repeat(64),
      generatePromptScheme: "qmd-query-expansion-v2.8.3",
      qmdGenerateUri: "hf:example/wanted-generate.gguf",
    };
    const receipt: InstalledModelsReceipt = {
      schemaVersion: 1,
      defaults: [],
      artifacts: [
        {
          capability: "rerank",
          selection: {
            provider: "gguf",
            model: "stale-first.gguf",
            revision: "stale-revision",
            sha256: "f".repeat(64),
          },
          path: "/models/stale-first.gguf",
        },
        {
          capability: "rerank",
          selection: {
            provider: "gguf",
            model: settings.rerankModel!,
            revision: settings.rerankRevision!,
            sha256: settings.rerankSha256!,
          },
          path: "/models/wanted-rerank.gguf",
        },
        {
          capability: "generate",
          selection: {
            provider: "gguf",
            model: settings.generateModel!,
            revision: settings.generateRevision!,
            sha256: settings.generateSha256!,
            promptScheme: settings.generatePromptScheme,
          },
          path: "/models/wanted-generate.gguf",
        },
      ],
    };

    expect(installedPrecisionIdentity(settings, receipt)).toMatchObject({
      rerank: { model: "wanted-rerank.gguf" },
      generate: { model: "wanted-generate.gguf" },
    });
  });
});
