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
  /** One-line meaning of the template; absent in contracts sealed before it existed. */
  readonly meaning?: string;
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
 * `field` is `path`, `template`, `contract`, `content`, a property key, a required heading
 * or an input key. It never carries a value or a pattern. The judge's own fields never name
 * a template; other `{field, kind}` reports, such as reseal loosening changes, may carry a
 * template name or a heading, which are vault-visible, never sealed values.
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
  "oms doctor contract",
  "oms doctor contract --fix",
  "oms doctor status",
  "oms setup host sync",
  "oms setup",
] as const;
export type Guidance = (typeof GUIDANCE)[number];

/** Total: exactly one guidance per kind. */
export const GUIDANCE_FOR: Readonly<Record<ViolationKind, Guidance>> = {
  "control-path": "oms doctor status",
  "yaml-syntax": "oms doctor status",
  "path-unsafe": "oms doctor status",
  "outside-vault": "oms doctor status",
  "contract-unreadable": "oms doctor contract",
  "unregistered-folder": "oms doctor status",
  "unknown-property": "oms doctor status",
  "missing": "oms doctor status",
  "type": "oms doctor status",
  "not-allowed": "oms doctor status",
  "not-fixed": "oms doctor status",
  "pattern": "oms doctor status",
  "range": "oms doctor status",
  "unsubstituted-variable": "oms doctor status",
  "heading-missing": "oms doctor status",
  "folder-mismatch": "oms doctor status",
  "template-mismatch": "oms doctor status",
  "unsupported-input": "oms setup host sync",
};

/** The first violation picks the one guidance; the reason carries `{field, kind}` only. */
export function formatDenyReason(violations: readonly Violation[]): string {
  const list = violations.map(violation => ({ field: violation.field, kind: violation.kind }));
  const guidance = violations.length === 0 ? "oms doctor status" : GUIDANCE_FOR[violations[0]!.kind];
  return `[oms] write denied: ${JSON.stringify(list)} Run: ${guidance}`;
}

/** What the judge sees of a vault's seal: nothing sealed, sealed but unreadable, or the contract. */
export type ContractView =
  | { readonly state: "open" }
  | { readonly state: "unreadable" }
  | { readonly state: "sealed"; readonly contract: VaultContract };
