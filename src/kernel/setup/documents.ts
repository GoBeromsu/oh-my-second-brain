import type { TemplateFolderCandidate, TemplateHintDiagnostic } from "../templates/hints.js";
import type { TemplatePolicy } from "../templates/types.js";

/**
 * Setup proposes an empty version 4 policy and nothing else.
 *
 * It discovers no templates, adopts no note types, and reads no template syntax.
 * Folder hints are raw observations the user may act on during the interview;
 * they are not selections and not contract meaning.
 */
export interface TemplateSetupQuestionnaire {
  readonly policyVersion: 4;
  /** The always-on default layer starts empty; individual templates are added by interview. */
  readonly defaultLayer: {
    readonly templatePath: string;
    readonly fields: readonly string[];
    readonly headings: readonly string[];
    readonly semanticCriteria: readonly string[];
  };
  readonly properties: readonly string[];
  readonly templates: readonly string[];
  /** Raw folder observations, with no syntax or contract inference. */
  readonly templateFolderHints: readonly { readonly path: string; readonly provenance: readonly string[] }[];
  readonly diagnostics: readonly { readonly code: string; readonly message: string; readonly path: string }[];
  readonly nextStep: "interview";
}

export interface TemplateSetupDocument {
  readonly questionnaire: TemplateSetupQuestionnaire;
  readonly policy: TemplatePolicy;
}

export function describeTemplateSetup(
  policy: TemplatePolicy,
  hints: {
    readonly candidates: readonly TemplateFolderCandidate[];
    readonly diagnostics: readonly TemplateHintDiagnostic[];
  },
): TemplateSetupDocument {
  return {
    questionnaire: {
      policyVersion: 4,
      defaultLayer: {
        templatePath: policy.default.templatePath,
        fields: Object.keys(policy.default.fields).sort(),
        headings: policy.default.headings.map(heading => heading.headingId),
        semanticCriteria: policy.default.semanticCriteria.map(criterion => criterion.criterionId),
      },
      properties: Object.keys(policy.properties).sort(),
      templates: Object.keys(policy.templates).sort(),
      templateFolderHints: hints.candidates.map(candidate => ({
        path: candidate.path,
        provenance: candidate.provenance.map(entry => String(entry)),
      })),
      diagnostics: hints.diagnostics.map(diagnostic => ({
        code: diagnostic.code,
        message: diagnostic.message,
        path: diagnostic.path,
      })),
      nextStep: "interview",
    },
    policy,
  };
}
