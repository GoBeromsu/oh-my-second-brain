import type { MigrationProposal } from "../templates/migration.js";

/** Read-only setup questionnaire; its proposal must be approved before guarded publication. */
export interface TemplateSetupQuestionnaire {
  readonly templateFolders: readonly {
    readonly path: string;
    readonly mode: "auto" | "manual";
    readonly default: boolean;
  }[];
  readonly discoveredTemplates: readonly {
    readonly templateId: string;
    readonly sourcePath: string;
    readonly sourceFolder: string;
    readonly publication: "verify-existing" | "write";
  }[];
  readonly noteIdentities: readonly { readonly path: string; readonly templateId: string | null }[];
  readonly droppedKeys: readonly string[];
  readonly diagnostics: readonly {
    readonly code: string;
    readonly message: string;
    readonly path?: string;
    readonly templateId?: string;
    readonly field?: string;
    readonly remediation?: string;
    readonly blocking: boolean;
  }[];
  readonly unresolvedMappings: readonly string[];
}

export interface TemplateSetupDocument { readonly questionnaire: TemplateSetupQuestionnaire; readonly proposal: MigrationProposal; }

export function describeTemplateSetup(proposal: MigrationProposal): TemplateSetupDocument {
  return {
    questionnaire: {
      templateFolders: proposal.templateFolders.map(folder => ({
        path: folder.path,
        mode: folder.mode,
        default: folder.default === true,
      })),
      discoveredTemplates: proposal.candidates.map(candidate => ({
        templateId: candidate.templateId,
        sourcePath: candidate.sourcePath,
        sourceFolder: candidate.sourceFolder,
        publication: candidate.publication,
      })),
      noteIdentities: proposal.existingNotes,
      droppedKeys: proposal.droppedKeys,
      diagnostics: proposal.diagnostics.map(diagnostic => ({ ...diagnostic })),
      unresolvedMappings: proposal.unresolved.map(item => `${item.code}: ${item.message}`),
    },
    proposal,
  };
}
