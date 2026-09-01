import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseModelsConfig, type ModelsConfigV1 } from "../engine/embed/config.js";
import { applyTemplateMigration, buildMigrationManifest, planTemplateMigration, type MigrationCompositionInput, type MigrationOptions, type MigrationProposal } from "../templates/migration.js";
import type { GuardedTemplateRequest, TemplateCompositionManifest, TemplateTransactionReceipt } from "../templates/types.js";
import { describeTemplateSetup, type TemplateSetupDocument } from "./documents.js";

export interface SetupState {
  readonly vault: string;
  readonly proposal: MigrationProposal;
  readonly document: TemplateSetupDocument;
}

export interface SetupInputs extends MigrationOptions {}

export interface SetupDecision {
  readonly vault: string;
  readonly proposal: MigrationProposal;
  readonly document: TemplateSetupDocument;
}

/** Discovery is recursive, side-effect free, and uses only vault-resident authority. */
export async function inspectSetup({ vault, templateFolder }: { vault: string; templateFolder?: string }): Promise<SetupState> {
  const proposal = await planTemplateMigration(vault, { templateFolder });
  return { vault, proposal, document: describeTemplateSetup(proposal) };
}

export async function decideSetup(state: SetupState, inputs: SetupInputs = {}): Promise<SetupDecision> {
  const proposal = await planTemplateMigration(state.vault, inputs);
  return { vault: state.vault, proposal, document: describeTemplateSetup(proposal) };
}

export async function decideNonInteractiveSetup(state: SetupState): Promise<SetupDecision> {
  return { vault: state.vault, proposal: state.proposal, document: state.document };
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
