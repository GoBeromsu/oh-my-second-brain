import {
  acquireModelSet,
  modelsConfigFromAcquisitionManifest,
  parseModelSetAcquisitionManifest,
  type ModelSetAcquisitionManifest,
} from "../kernel/engine/embed/model.js";
import {
  applySetup,
  composeSetup,
  decideNonInteractiveSetup,
  inspectSetup,
  publishSetupModels,
} from "../kernel/setup/service.js";
import type { Digest } from "../kernel/templates/types.js";
import { buildClaudeInstallPlan, printClaudeInstallPlan } from "./claude-install-plan.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface SetupPrompt {
  question(query: string): Promise<string>;
  close(): void;
}

export type SetupOutcome = "blocked" | "completed";

export async function runSetup(opts: {
  vault: string;
  yes: boolean;
  installClaude?: boolean;
  dryRun?: boolean;
  approvedDigest?: Digest;
  templateFolder?: string;
  prompt?: SetupPrompt;
  /** Strict setup-only acquisition manifest for one or more model capabilities. */
  modelSetManifest?: ModelSetAcquisitionManifest | unknown;
  /** User-level model cache override, primarily for setup automation/tests. */
  modelCacheDir?: string;
  /** Explicitly waive installing a default model set and preserve vault config. */
  modelsNoDefault?: boolean;
  /** Fetch seam for setup tests; production uses global fetch. */
  modelFetchImpl?: typeof fetch;
}): Promise<SetupOutcome> {
  const {
    vault,
    yes,
    installClaude = false,
    dryRun = false,
    approvedDigest,
    templateFolder,
    modelSetManifest,
    modelCacheDir,
    modelsNoDefault = false,
    modelFetchImpl,
  } = opts;
  if (!yes && !dryRun) throw new Error("Setup apply requires --yes and an approved dry-run digest.");
  if (!dryRun && (approvedDigest === undefined || !DIGEST.test(approvedDigest))) throw new Error("Setup apply requires approvedDigest from a shown dry-run proposal.");
  if (modelSetManifest !== undefined && modelsNoDefault) throw new Error("Setup modelSetManifest and modelsNoDefault are mutually exclusive.");

  const modelManifest = modelSetManifest === undefined
    ? undefined
    : parseModelSetAcquisitionManifest(modelSetManifest);
  const proposedModelsConfig = modelManifest === undefined
    ? undefined
    : modelsConfigFromAcquisitionManifest(modelManifest);
  const state = await inspectSetup({ vault, templateFolder });
  if (state.proposal.unresolved.length > 0) {
    console.log(JSON.stringify({
      status: "blocked",
      diagnostics: state.proposal.unresolved.map(({ code, message, path }) => ({
        code,
        remediation: message,
        ...(path === undefined ? {} : { path }),
      })),
    }, null, 2));
    process.exitCode = 1;
    return "blocked";
  }
  const decision = await decideNonInteractiveSetup(state);
  const manifest = await composeSetup(decision, { base: { fields: {} } });
  if (dryRun) {
    const receipt = await applySetup(decision, manifest, { dryRun: true });
    console.log(JSON.stringify({
      inputDigest: manifest.proposed.inputDigest,
      approvalDigest: manifest.approvalDigest,
      outputDigest: manifest.outputDigest,
      ...(proposedModelsConfig === undefined ? {} : { modelsConfig: proposedModelsConfig }),
      receipt,
    }, null, 2));
    return "completed";
  }
  if (approvedDigest === undefined) throw new Error("Setup apply requires approvedDigest from a shown dry-run proposal.");
  const receipt = await applySetup(decision, manifest, { approvedDigest });
  if (receipt.status === "rejected" || receipt.status === "inconsistent") throw new Error(receipt.diagnostics.map(item => item.code).join(","));

  if (modelManifest !== undefined) {
    const acquired = await acquireModelSet({
      vault,
      cacheDir: modelCacheDir,
      manifest: modelManifest,
      fetchImpl: modelFetchImpl,
    });
    const modelsConfigUpdated = await publishSetupModels(decision, receipt, { approvedDigest }, acquired.config);
    for (const capability of ["embed", "rerank", "generate"] as const) {
      const model = acquired.config[capability];
      if (model !== undefined) console.log(`Model: ${capability} ${model.provider}/${model.model}@${model.revision}`);
    }
    console.log(`${modelsConfigUpdated ? "Written" : "Unchanged"}:  .oms/models.json`);
  }
  console.log(`Oh My Second Brain setup complete. Approval: ${manifest.approvalDigest}`);
  if (modelsNoDefault) console.log("Models: no default (explicit waiver)");
  if (installClaude) printClaudeInstallPlan(buildClaudeInstallPlan({ vault }));
  return "completed";
}
