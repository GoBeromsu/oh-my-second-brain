import type { Digest } from "../conventions/canonical.js";
import type { ObsidianContractType } from "./obsidian.js";

/**
 * The sealed vault contract. Every value lives only in the store outside the vault
 * (`~/.oms/vaults/<id>/`); agents see `{field, kind}` only.
 */

export type { Digest };
export type JsonScalar = string | number | boolean | null;
export type FieldType = ObsidianContractType;
export type VariableKind = "date" | "datetime" | "title" | "free";

export type Rule =
  | { readonly kind: "allowed"; readonly values: readonly JsonScalar[] }
  | { readonly kind: "fixed"; readonly value: JsonScalar }
  | { readonly kind: "pattern"; readonly regex: string }
  | { readonly kind: "range"; readonly min?: number | string; readonly max?: number | string };

export interface FolderContract {
  readonly meaning: string;
  readonly searchExclude: boolean;
}

export interface PropertyContract {
  readonly meaning: string;
  readonly type: FieldType;
  /** Missing but not required: the write passes and the name is reported in `missingDefaults`. */
  readonly default: boolean;
  readonly required: boolean;
  readonly rules: readonly Rule[];
}

export interface TemplateContract {
  /** Vault-relative template source path. */
  readonly source: string;
  readonly sourceHash: Digest;
  readonly applyFolder?: string;
  readonly requiredProperties: readonly string[];
  readonly narrowedRules: Readonly<Record<string, readonly Rule[]>>;
  readonly requiredHeadings: readonly string[];
}

/** Null axis = open (nothing sealed for it). Templates are keyed by name. */
export interface VaultContract {
  readonly folders: Readonly<Record<string, FolderContract>> | null;
  readonly properties: Readonly<Record<string, PropertyContract>> | null;
  readonly templates: Readonly<Record<string, TemplateContract>>;
}

export interface JudgeInput {
  /** Vault-relative note path. */
  readonly path: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
  /** Template name the writer explicitly chose. */
  readonly selectedTemplate?: string;
  /** Raw content of the note before this write; absent for a new file. */
  readonly previousContent?: string;
}

export type ViolationKind =
  | "control-path"
  | "yaml-syntax"
  | "path-unsafe"
  | "outside-vault"
  | "contract-unreadable"
  | "unregistered-folder"
  | "unknown-property"
  | "missing"
  | "type"
  | "not-allowed"
  | "not-fixed"
  | "pattern"
  | "range"
  | "unsubstituted-variable"
  | "heading-missing"
  | "folder-mismatch"
  | "template-mismatch"
  | "unsupported-input";

export const VIOLATION_KINDS: readonly ViolationKind[] = [
  "control-path", "yaml-syntax", "path-unsafe", "outside-vault", "contract-unreadable",
  "unregistered-folder", "unknown-property", "missing", "type", "not-allowed", "not-fixed",
  "pattern", "range", "unsubstituted-variable", "heading-missing", "folder-mismatch",
  "template-mismatch", "unsupported-input",
];

/**
 * `field` is `path`, `template`, `contract`, `content`, a property key or an input key.
 * It never carries a value, a pattern or a template name.
 */
export interface Violation {
  readonly field: string;
  readonly kind: ViolationKind;
}

export interface Verdict {
  readonly ok: boolean;
  readonly violations: readonly Violation[];
  readonly missingDefaults: readonly string[];
}

/** The only command names agent-facing output may contain. */
export const GUIDANCE = [
  "oms contract doctor",
  "oms contract doctor --fix",
  "oms status",
  "oms host sync",
  "oms setup",
] as const;
export type Guidance = (typeof GUIDANCE)[number];

/** Total: exactly one guidance per kind. */
export const GUIDANCE_FOR: Readonly<Record<ViolationKind, Guidance>> = {
  "control-path": "oms status",
  "yaml-syntax": "oms status",
  "path-unsafe": "oms status",
  "outside-vault": "oms status",
  "contract-unreadable": "oms contract doctor",
  "unregistered-folder": "oms status",
  "unknown-property": "oms status",
  "missing": "oms status",
  "type": "oms status",
  "not-allowed": "oms status",
  "not-fixed": "oms status",
  "pattern": "oms status",
  "range": "oms status",
  "unsubstituted-variable": "oms status",
  "heading-missing": "oms status",
  "folder-mismatch": "oms status",
  "template-mismatch": "oms status",
  "unsupported-input": "oms host sync",
};

/** The first violation picks the one guidance; the reason carries `{field, kind}` only. */
export function formatDenyReason(violations: readonly Violation[]): string {
  const list = violations.map(violation => ({ field: violation.field, kind: violation.kind }));
  const guidance = violations.length === 0 ? "oms status" : GUIDANCE_FOR[violations[0]!.kind];
  return `[oms] write denied: ${JSON.stringify(list)} Run: ${guidance}`;
}

/** What the judge sees of a vault's seal: nothing sealed, sealed but unreadable, or the contract. */
export type ContractView =
  | { readonly state: "open" }
  | { readonly state: "unreadable" }
  | { readonly state: "sealed"; readonly contract: VaultContract };
