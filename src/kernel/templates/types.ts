import type { CompletionCriterion } from "../conventions/completion-contract.js";

export type { CompletionCriterion };

/** Lowercase sha256 digest. Binding material, not an authentication secret. */
export type Digest = `sha256:${string}`;
export type DestinationClass = "managed-default" | "registered-existing";
export type TemplateFolderPath = string & { readonly __kind: "TemplateFolderPath" };
export type TemplateSourcePath = string & { readonly __kind: "TemplateSourcePath" };
export type TemplateId = string & { readonly __kind: "TemplateId" };
/** Approved managed draft under `.oms/templates/`. Not a user source path. */
export type ManagedTemplatePath = string & { readonly __kind: "ManagedTemplatePath" };
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type Extensions = Readonly<Record<string, JsonValue>>;
export type ObsidianContractType = "text" | "string" | "select" | "number" | "boolean" | "checkbox" | "date" | "datetime" | "list" | "multitext" | "multi" | "tags" | "aliases" | "file";
export type PropertyFormat = "url";
export type HeadingOrder = "unordered" | "strict";
export type AgentRepairContext = "post-write" | "maintenance";

export const DEFAULT_MANAGED_TEMPLATE_PATH = ".oms/templates/default.md" as ManagedTemplatePath;
export const COMPLETION_RETRY_BUDGET_DEFAULT = 2;

export interface TemplateFolderRegistration {
  readonly path: TemplateFolderPath;
  readonly default?: true;
  readonly extensions?: Extensions;
}

/** User-owned property pool entry. Layers reference it; they do not restate type, intent, or format. */
export interface PropertyDefinition {
  readonly type: ObsidianContractType;
  readonly intent: string;
  readonly allowedValues?: readonly string[];
  readonly format?: PropertyFormat;
  readonly extensions?: Extensions;
}

/**
 * Field use inside the default layer or one template layer.
 * `required` may only be added, never cleared. Omitted `allowedValues` inherit the parent ceiling;
 * a declared list must be a subset of that ceiling. Type, intent, and format stay on the pool.
 */
export interface LayerFieldRef {
  readonly property: string;
  readonly required?: true;
  readonly allowedValues?: readonly string[];
  readonly extensions?: Extensions;
}

export interface HeadingContract {
  readonly headingId: string;
  readonly title: string;
  readonly level: number;
  readonly required: true;
  readonly extensions?: Extensions;
}

/** Optional link from an individual template to the raw source the agent interprets. */
export interface TemplateSourceRef {
  readonly path: TemplateSourcePath;
  readonly identity: string;
  readonly rawDigest: Digest;
}

export interface ApprovedLayerBytes {
  readonly templatePath: ManagedTemplatePath;
  readonly approvedMarkdown: string;
  readonly approvedMarkdownDigest: Digest;
}

/** Always-on default layer, or the shared shape of an individual template layer. */
export interface ContractLayer extends ApprovedLayerBytes {
  readonly fields: Readonly<Record<string, LayerFieldRef>>;
  readonly headings: readonly HeadingContract[];
  /** Omitted on the default layer means unordered. Omitted on a template means inherit. */
  readonly headingOrder?: HeadingOrder;
  readonly semanticCriteria: readonly CompletionCriterion[];
  readonly extensions?: Extensions;
}

export interface TemplateLayer extends ContractLayer {
  readonly templateId: TemplateId;
  readonly source?: TemplateSourceRef;
}

export interface AgentRepairPolicy {
  /** Default false. Search and check never grant repair authority. */
  readonly enabled: boolean;
  readonly contexts?: readonly AgentRepairContext[];
  readonly extensions?: Extensions;
}

/** Operational settings. Excluded from `contractDigest` so a budget edit does not stale an approved contract. */
export interface CompletionPolicy {
  readonly retryBudget: number;
  readonly agentRepair: AgentRepairPolicy;
  readonly extensions?: Extensions;
}

export interface TemplatePolicy {
  readonly version: 4;
  readonly properties: Readonly<Record<string, PropertyDefinition>>;
  readonly default: ContractLayer;
  readonly templates: Readonly<Record<string, TemplateLayer>>;
  readonly completion: CompletionPolicy;
  readonly extensions?: Extensions;
}

/**
 * Effective field after P03 composes the pool, default layer, and optional template layer.
 * Type, intent, and format come only from the pool. Required is true if either layer sets it.
 * Allowed values, when declared, are the narrowed subset; omission inherits rather than clearing.
 */
export interface ResolvedField {
  readonly property: string;
  readonly type: ObsidianContractType;
  readonly intent: string;
  readonly required: boolean;
  readonly allowedValues?: readonly string[];
  readonly format?: PropertyFormat;
}

export interface ResolvedHeading extends HeadingContract {
  /** `template` means this heading id was added by the individual layer. Default ids stay on the default layer. */
  readonly origin: "default" | "template";
}

/**
 * Composed contract for one note. P03 fills it from a parsed policy.
 * `approved` carries the exact markdown snapshots; this object does not replace them.
 */
export interface ResolvedContract {
  readonly templateId: TemplateId | null;
  readonly headingOrder: HeadingOrder;
  readonly fields: Readonly<Record<string, ResolvedField>>;
  readonly headings: readonly ResolvedHeading[];
  readonly semanticCriteria: readonly CompletionCriterion[];
  readonly approved: {
    readonly defaultLayer: ApprovedLayerBytes;
    readonly templateLayer?: ApprovedLayerBytes;
  };
  readonly contractDigest: Digest;
}

export interface GlobalAxis {
  readonly kind: "folder" | "link";
  readonly key: string;
  readonly type: ObsidianContractType;
  readonly intent?: string;
  readonly members: readonly JsonValue[];
  readonly extensions?: Extensions;
}
export type GlobalAxes = Readonly<Record<string, GlobalAxis>>;

export interface DerivedTemplateProjection {
  readonly templateId: TemplateId;
  readonly headingOrder: HeadingOrder;
  readonly fields: Readonly<Record<string, ResolvedField>>;
  readonly headings: readonly HeadingContract[];
  readonly contractDigest: Digest;
  readonly approvedMarkdownDigest: Digest;
  readonly extensions?: Extensions;
}

/** Derivative of effective fields, headings, and axes. Not semantic or markdown authority. */
export interface DerivedProjection {
  readonly version: "oms.types.v2";
  readonly generatedFrom: Digest;
  readonly managed: {
    readonly headingOrder: HeadingOrder;
    readonly fields: Readonly<Record<string, ResolvedField>>;
    readonly headings: readonly HeadingContract[];
    readonly globalAxes: GlobalAxes;
    readonly templates: Readonly<Record<string, DerivedTemplateProjection>>;
    readonly extensions?: Extensions;
  };
  readonly extensions?: Extensions;
}

export interface SourceFreshness {
  readonly templateId: TemplateId;
  readonly source: TemplateSourceRef;
  readonly observedRawDigest: Digest | null;
  readonly drift: "SOURCE_DRIFT" | null;
}

export interface ManagedDraftFreshness {
  readonly templateId: TemplateId | null;
  readonly templatePath: ManagedTemplatePath;
  readonly approvedMarkdownDigest: Digest;
  readonly observedDraftDigest: Digest | null;
  readonly drift: "MANAGED_TEMPLATE_DRIFT" | null;
}

export type AuthorityKind = "template" | "policy" | "taxonomy" | "obsidian-types";
export interface AuthorityEntry {
  readonly kind: AuthorityKind;
  readonly logicalId: string;
  readonly vaultRelativePath: string | null;
  readonly contentDigest: Digest;
}
export interface PlacementEntry {
  readonly templateId: TemplateId;
  readonly destinationClass: DestinationClass;
  readonly templateFolder: TemplateFolderPath | null;
  readonly sourceFolder: TemplateFolderPath;
  readonly sourcePath: TemplateSourcePath;
}
/** Existing canonical migration-input frame. Not a version 4 policy and not a compatibility reader. */
export interface InputV2 {
  readonly version: 2;
  readonly templateFolders: readonly TemplateFolderRegistration[];
  readonly authority: readonly AuthorityEntry[];
  readonly placement: readonly PlacementEntry[];
}

export type DiagnosticCode =
  | "TEMPLATE_ID_DUPLICATE"
  | "TEMPLATE_SOURCE_DUPLICATE"
  | "TEMPLATE_SOURCE_UNSAFE"
  | "TEMPLATE_SOURCE_INVALID"
  | "TEMPLATE_POLICY_INVALID"
  | "TEMPLATE_POLICY_VERSION_UNSUPPORTED"
  | "TEMPLATE_POLICY_DANGLING_FIELD"
  | "TEMPLATE_EXTENSION_RESERVED"
  | "TEMPLATE_EXTENSION_CONFLICT"
  | "CONTRACT_COMPOSITION_CONFLICT"
  | "CONTRACT_UNVERIFIABLE"
  | "SOURCE_DRIFT"
  | "MANAGED_TEMPLATE_DRIFT"
  | "CONTRACT_TRANSACTION_IN_PROGRESS"
  | "PROJECTION_INVALID"
  | "PROJECTION_PAYLOAD_TAMPERED"
  | "OBSIDIAN_TYPE_CONFLICT"
  | "RUBRIC_INVALID"
  | "TEMPLATE_TRANSACTION_INCONSISTENT"
  | "TEMPLATE_TRANSACTION_MANIFEST_INVALID";

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly templateId?: TemplateId;
  readonly path?: string;
  readonly field?: string;
  readonly message?: string;
  readonly extensions?: Extensions;
}

export type ControlKind = "policy" | "taxonomy" | "projection";
export type ControlPath = ".oms/template-policy.json" | ".oms/taxonomy.json" | ".oms/types.json";
export type TemplateTransactionMarkerPath = ".oms/template-transaction.json";
export type TransactionPath = ControlPath | ManagedTemplatePath;
export type FileExpectation = { readonly state: "absent" } | { readonly state: "present"; readonly signature: Digest };
export type VerifiedFileState = { readonly state: "absent" } | { readonly state: "present"; readonly bytes: Uint8Array; readonly signature: Digest };

export interface ControlTransition<K extends ControlKind, P extends ControlPath> {
  readonly kind: K;
  readonly path: P;
  readonly expectedCurrent: FileExpectation;
  readonly current: VerifiedFileState;
  readonly proposed: Extract<VerifiedFileState, { readonly state: "present" }>;
  readonly action: "write" | "verify-only";
}

export interface ManagedDraftExpectation {
  readonly templateId: TemplateId | null;
  readonly path: ManagedTemplatePath;
  readonly expected: FileExpectation;
}

export interface ManagedDraftTransition {
  readonly templateId: TemplateId | null;
  readonly path: ManagedTemplatePath;
  readonly expectedCurrent: FileExpectation;
  readonly current: VerifiedFileState;
  readonly proposed: VerifiedFileState;
  readonly action: "write" | "verify-only";
}

export interface LogicalOperation {
  readonly kind: "commit-contract";
  readonly templateId: TemplateId | null;
  readonly payloadDigest: Digest;
}

export interface PlannedPhysicalOutput {
  readonly finalVaultRelativePath: TransactionPath;
  readonly payloadDigest: Digest;
}

/** Approval manifest for policy, taxonomy, projection, and approved managed drafts. User sources are not outputs. */
export interface TemplateCompositionManifest {
  readonly version: 1;
  readonly markerPath: TemplateTransactionMarkerPath;
  readonly controls: readonly [
    ControlTransition<"policy", ".oms/template-policy.json">,
    ControlTransition<"taxonomy", ".oms/taxonomy.json">,
    ControlTransition<"projection", ".oms/types.json">,
  ];
  readonly drafts: readonly ManagedDraftTransition[];
  readonly operations: readonly LogicalOperation[];
  readonly diagnostics: readonly Diagnostic[];
  readonly outputs: readonly PlannedPhysicalOutput[];
  readonly approvalDigest: Digest;
  readonly outputDigest: Digest;
}

export interface TemplateCasExpectation {
  readonly controls: Readonly<{
    policy: FileExpectation;
    taxonomy: FileExpectation;
    projection: FileExpectation;
  }>;
  readonly drafts: readonly ManagedDraftExpectation[];
}

export interface TemplateDryRunRequest {
  readonly dryRun: true;
  readonly approvedDigest?: never;
}
export interface TemplateApplyRequest {
  readonly dryRun?: false;
  readonly approvedDigest: Digest;
}
export type GuardedTemplateRequest = TemplateDryRunRequest | TemplateApplyRequest;

export interface TemplateTransactionMarker {
  readonly status: "in-progress" | "complete";
  readonly transactionId: string;
  readonly approvalDigest: Digest;
  readonly outputDigest?: Digest;
}

export interface TransactionVerifiedPath {
  readonly path: TransactionPath;
  readonly state: "absent" | "present";
  readonly payloadDigest?: Digest;
}

export type TemplateTransactionReceipt =
  | {
      readonly status: "planned" | "unchanged";
      readonly approvalDigest: Digest;
      readonly outputDigest: Digest;
      readonly outputs: readonly PlannedPhysicalOutput[];
    }
  | {
      readonly status: "applied" | "already-complete";
      readonly transactionId: string;
      readonly approvalDigest: Digest;
      readonly outputDigest: Digest;
      readonly writtenPaths: readonly TransactionPath[];
      readonly verified: readonly TransactionVerifiedPath[];
      readonly markerState: "complete";
    }
  | {
      readonly status: "resume-required" | "inconsistent" | "rejected";
      readonly approvalDigest: Digest | null;
      readonly outputDigest: Digest | null;
      readonly diagnostics: readonly Diagnostic[];
    };
