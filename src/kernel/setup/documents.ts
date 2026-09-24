import type { TemplateFolderCandidate, TemplateHintDiagnostic } from "../templates/hints.js";
import type { Digest } from "../templates/types.js";

/**
 * Fresh setup reports the actual contract and raw folder observations.
 * It invents no policy body, active flag, physical default, placement, or selected root.
 */
export interface FreshSetupPolicySummary {
  readonly version: 5;
  readonly revision: number;
  readonly commonStatus: "active" | "review-required";
}

/** Diagnostic metadata copied from the actual rolled-back marker. It authorizes nothing. */
export interface FreshSetupMigrationRetryAnchor {
  readonly kind: "schema-migration";
  readonly status: "rolled-back";
  readonly transactionId: string;
  readonly planDigest: Digest;
}

export type FreshSetupNextStep = "configure-contract" | "identity-setup-required" | "review-contract" | "select-contract" | "resolve-blocker";

export interface FreshSetupDocument {
  readonly state: "contract-configured" | "contract-setup-required" | "held-legacy" | "blocked";
  readonly nextStep: FreshSetupNextStep;
  readonly policy?: FreshSetupPolicySummary;
  readonly migrationRetryAnchor?: FreshSetupMigrationRetryAnchor;
  readonly templateFolderHints: readonly TemplateFolderCandidate[];
  readonly hintDiagnostics: readonly TemplateHintDiagnostic[];
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
}

export function describeFreshSetup(input: {
  readonly state: FreshSetupDocument["state"];
  readonly settingsPresent: boolean;
  readonly policy?: FreshSetupPolicySummary;
  readonly migrationRetryAnchor?: FreshSetupMigrationRetryAnchor;
  readonly hints: { readonly candidates: readonly TemplateFolderCandidate[]; readonly diagnostics: readonly TemplateHintDiagnostic[] };
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
}): FreshSetupDocument {
  return {
    state: input.state,
    nextStep: nextStep(input.state, input.settingsPresent, input.policy),
    ...(input.policy === undefined ? {} : { policy: input.policy }),
    ...(input.migrationRetryAnchor === undefined ? {} : { migrationRetryAnchor: input.migrationRetryAnchor }),
    templateFolderHints: input.hints.candidates,
    hintDiagnostics: input.hints.diagnostics,
    diagnostics: input.diagnostics,
  };
}

function nextStep(state: FreshSetupDocument["state"], settingsPresent: boolean, policy: FreshSetupPolicySummary | undefined): FreshSetupNextStep {
  if (state === "held-legacy" || state === "blocked") return "resolve-blocker";
  if (policy?.commonStatus === "review-required") return "review-contract";
  if (state === "contract-setup-required" || policy === undefined) return "configure-contract";
  return settingsPresent ? "select-contract" : "identity-setup-required";
}
