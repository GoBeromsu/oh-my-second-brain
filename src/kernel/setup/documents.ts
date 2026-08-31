import type { MigrationProposal } from "../templates/migration.js";

/** Read-only setup questionnaire; its proposal must be approved before guarded publication. */
export interface TemplateSetupQuestionnaire {
  readonly templateFolder: string;
  readonly discoveredTemplates: readonly { readonly templateId: string; readonly sourcePath: string }[];
  readonly registeredExistingTemplates: readonly string[];
  readonly stableBindingClones: readonly { readonly folder: string; readonly templateId: string; readonly sourcePath: string }[];
  readonly noteIdentities: readonly { readonly path: string; readonly templateId: string | null; readonly legacyConcept: string | null }[];
  readonly unresolvedMappings: readonly string[];
}

export interface TemplateSetupDocument { readonly questionnaire: TemplateSetupQuestionnaire; readonly proposal: MigrationProposal; }

export function describeTemplateSetup(proposal: MigrationProposal): TemplateSetupDocument {
  return {
    questionnaire: {
      templateFolder: proposal.templateFolder,
      discoveredTemplates: proposal.candidates.map(candidate => ({ templateId: candidate.templateId, sourcePath: candidate.sourcePath })),
      registeredExistingTemplates: proposal.candidates.filter(candidate => candidate.destinationClass === "registered-existing").map(candidate => candidate.sourcePath),
      stableBindingClones: proposal.bindingClones.map(clone => ({ folder: clone.folder, templateId: clone.templateId, sourcePath: clone.sourcePath })),
      noteIdentities: proposal.existingNotes,
      unresolvedMappings: proposal.unresolved.map(item => `${item.code}: ${item.message}`),
    },
    proposal,
  };
}
