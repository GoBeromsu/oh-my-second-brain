import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseModelsConfig, type ModelsConfigV1 } from "../engine/embed/config.js";
import { applyTemplateMigration, buildMigrationManifest, planTemplateMigration, type MigrationCompositionInput, type MigrationOptions, type MigrationProposal } from "../templates/migration.js";
import { proposeTemplateFolders, type TemplateFolderCandidate, type TemplateHintDiagnostic } from "../templates/hints.js";
import type { GuardedTemplateRequest, TemplateCompositionManifest, TemplateTransactionReceipt } from "../templates/types.js";
import { describeTemplateSetup, type TemplateSetupDocument } from "./documents.js";

export interface SetupState {
  readonly vault: string;
  readonly proposal: MigrationProposal;
  readonly document: TemplateSetupDocument;
  readonly templateFolderCandidates: readonly TemplateFolderCandidate[];
  readonly templateFolderHintDiagnostics: readonly TemplateHintDiagnostic[];
  readonly selectedTemplateFolders: MigrationProposal["templateFolders"];
  readonly templateFolderSource?: "explicit" | "stored-v3";
}

export interface SetupInputs extends MigrationOptions {}

export interface SetupDecision {
  readonly vault: string;
  readonly proposal: MigrationProposal;
  readonly document: TemplateSetupDocument;
  readonly templateFolderCandidates: readonly TemplateFolderCandidate[];
  readonly templateFolderHintDiagnostics: readonly TemplateHintDiagnostic[];
  readonly selectedTemplateFolders: MigrationProposal["templateFolders"];
  readonly templateFolderSource?: "explicit" | "stored-v3";
}

/** Discovery is recursive, side-effect free, and uses only vault-resident authority. */
export async function inspectSetup({
  vault,
  templateFolders,
}: {
  vault: string;
  templateFolders?: MigrationOptions["templateFolders"];
}): Promise<SetupState> {
  return setupState(vault, { templateFolders });
}

export async function decideSetup(state: SetupState, inputs: SetupInputs = {}): Promise<SetupDecision> {
  return setupState(state.vault, inputs);
}

export async function decideNonInteractiveSetup(state: SetupState): Promise<SetupDecision> {
  return state;
}

async function setupState(vault: string, inputs: MigrationOptions): Promise<SetupState> {
  const proposal = await planTemplateMigration(vault, inputs);
  const source =
    inputs.templateFolders !== undefined && inputs.templateFolders.length > 0
      ? "explicit" as const
      : proposal.currentPolicy !== undefined && proposal.templateFolders.length > 0
        ? "stored-v3" as const
        : undefined;
  const hints = await proposeTemplateFolders(vault, {
    selected: source === undefined
      ? []
      : proposal.templateFolders.map(folder => ({ path: folder.path, provenance: source })),
  });
  return {
    vault,
    proposal,
    document: describeTemplateSetup(proposal),
    templateFolderCandidates: hints.candidates,
    templateFolderHintDiagnostics: hints.diagnostics,
    selectedTemplateFolders: proposal.templateFolders,
    ...(source === undefined ? {} : { templateFolderSource: source }),
  };
}

/** Setup apply delegates publication to the migration transaction and cannot write directly. */
export async function composeSetup(decision: SetupDecision, input: MigrationCompositionInput): Promise<TemplateCompositionManifest> {
  return buildMigrationManifest(decision.vault, decision.proposal, input);
}

export async function applySetup(decision: SetupDecision, manifest: TemplateCompositionManifest, request: GuardedTemplateRequest): Promise<TemplateTransactionReceipt> {
  return applyTemplateMigration(decision.vault, decision.proposal, manifest, request);
}

/** Publish portable selections only after their template transaction was approved and applied. */
export async function publishSetupModels(
  decision: SetupDecision,
  receipt: TemplateTransactionReceipt,
  request: GuardedTemplateRequest,
  modelsConfig: ModelsConfigV1,
): Promise<boolean> {
  if (request.dryRun === true || (receipt.status !== "applied" && receipt.status !== "already-complete")) {
    throw new Error("MIGRATION_APPROVAL_MISMATCH");
  }
  const content = `${JSON.stringify(parseModelsConfig(modelsConfig), null, 2)}\n`;
  const modelsPath = path.join(decision.vault, ".oms", "models.json");
  try {
    if (await readFile(modelsPath, "utf8") === content) return false;
  } catch (error: unknown) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(modelsPath), { recursive: true });
  await writeFile(modelsPath, content, "utf8");
  return true;
}
