import { createInterface } from "node:readline/promises";
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
  decideSetup,
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
  templateFolders?: readonly string[];
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
    templateFolders,
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
  const selected = templateFolders?.map((path, index) => ({ path, mode: "auto" as const, ...(index === 0 ? { default: true as const } : {}) }));
  let state = await inspectSetup({ vault, templateFolders: selected });
  if (state.selectedTemplateFolders.length === 0 && (opts.prompt !== undefined || process.stdin.isTTY)) {
    const prompt = opts.prompt ?? createInterface({ input: process.stdin, output: process.stdout });
    try {
      const candidates = state.templateFolderCandidates;
      for (const [index, candidate] of candidates.entries()) console.log(`${index + 1}. ${candidate.path} (${candidate.provenance.join(", ")})`);
      const answer = await prompt.question(candidates.length === 0
        ? "Template folder (explicit vault-relative path; blank leaves setup blocked): "
        : "Select template folder numbers separated by commas (first is creation default; blank leaves setup blocked): ");
      let paths: string[] = [];
      if (answer.trim() !== "") {
        if (candidates.length === 0) paths = [answer.trim()];
        else {
          const indexes = answer.split(",").map(value => Number(value.trim()));
          if (indexes.some(index => !Number.isInteger(index) || index < 1 || index > candidates.length) || new Set(indexes).size !== indexes.length) throw new Error("TEMPLATE_FOLDER_SELECTION_REQUIRED: choose distinct displayed folder numbers");
          paths = indexes.map(index => candidates[index - 1]!.path);
        }
      }
      if (paths.length > 0) state = await decideSetup(state, { templateFolders: paths.map((path, index) => ({ path, mode: "auto", ...(index === 0 ? { default: true as const } : {}) })) });
    } finally { prompt.close(); }
  }
  if (state.proposal.unresolved.length > 0) {
    console.log(JSON.stringify({
      status: "blocked",
      templateFolderCandidates: state.templateFolderCandidates,
      templateFolderHintDiagnostics: state.templateFolderHintDiagnostics,
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
  let manifest;
  try { manifest = await composeSetup(decision, { base: { fields: {} } }); }
  catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({ status: "blocked", diagnostics: [{ code: detail.match(/^([A-Z][A-Z0-9_]+)/)?.[1] ?? "SETUP_COMPOSITION_FAILED", remediation: detail }], templateFolders: state.selectedTemplateFolders }, null, 2));
    process.exitCode = 1;
    return "blocked";
  }
  if (dryRun) {
    const receipt = await applySetup(decision, manifest, { dryRun: true });
    if (receipt.status === "rejected" || receipt.status === "inconsistent") {
      console.log(JSON.stringify({ status: "blocked", diagnostics: receipt.diagnostics }, null, 2));
      process.exitCode = 1;
      return "blocked";
    }
    console.log(JSON.stringify({
      templateFolders: state.selectedTemplateFolders,
      templateFolderSource: state.templateFolderSource,
      droppedKeys: state.proposal.droppedKeys,
      policyPreimage: manifest.controls[0].expectedCurrent,
      policyProposal: JSON.parse(new TextDecoder().decode(manifest.controls[0].proposed.bytes)) as unknown,
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
