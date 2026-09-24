export { approvalDigest, canonicalJson, digestBytes, frameHash, hashCanonical, outputDigest } from "./canonical.js";
export { axisValueEquals, deriveTemplateRetrievalAxes } from "./axes.js";
export type { SearchableAxis, TemplateAxisSet, TemplateFieldAxis, TemplateIdentityAxis, TemplateRetrievalAxes, TemplateRetrievalSource } from "./axes.js";
export {
  buildTemplateNoteIndex,
  classifyNoteTemplateIdentity,
  queryTemplateAxis,
  queryTemplateLexically,
  TEMPLATE_NOTE_INDEX_VERSION,
} from "./note-index.js";
export type {
  LexicalNoteMatch,
  NoteTemplateIdentity,
  TemplateAxisQuery,
  TemplateIndexedNote,
  TemplateNoteDiagnostic,
  TemplateNoteIndex,
  TemplateNoteLayer,
  TemplateNoteUnresolved,
} from "./note-index.js";
export {
  canonicalPathKey,
  normalizeManagedTemplatePath,
  normalizeTemplateControlPath,
  normalizeTemplateFolderPath,
  normalizeTemplateSourcePath,
  validateTemplateId,
  verifyManagedTemplatePath,
  verifyTemplateControlPath,
  verifyTemplateFolderPath,
  verifyTemplateSourcePath,
  verifyVaultPath,
} from "./paths.js";
export type { VaultPathVerificationOptions, VerifiedVaultPath } from "./paths.js";
export {
  DERIVED_PROJECTION_SCHEMA,
  TEMPLATE_POLICY_SCHEMA,
  contractDigest,
  parseDerivedProjection,
  parseTemplatePolicy,
  serializeDerivedProjection,
  serializeTemplatePolicy,
  validateDerivedProjection,
} from "./policy.js";
export {
  controlGenerationDigest,
  deriveFolderOntologyAxis,
  expectedProjectionManaged,
  taxonomyRouting,
} from "./resolver.js";
export type { TaxonomyRouting } from "./resolver.js";
export type {
  Diagnostic,
  DiagnosticCode,
  Digest,
  FileExpectation,
  GlobalAxes,
  GlobalAxis,
  GuardedTemplateRequest,
  HeadingContract,
  JsonValue,
  LogicalOperation,
  ManagedTemplatePath,
  ObsidianContractType,
  PlannedPhysicalOutput,
  PropertyDefinition,
  ResolvedContract,
  ResolvedField,
  ResolvedHeading,
  TemplateCompositionManifest,
  TemplateFolderPath,
  TemplateId,
  TemplatePolicy,
  TemplateSourcePath,
  TemplateTransactionReceipt,
  VerifiedFileState,
} from "./types.js";
