import type { Digest, ObsidianContractType } from "../templates/types.js";

/**
 * ADR-007 sealed two-layer contract. The public part lives in the vault
 * (`.oms/contract-public.json`); hidden rules live only in the per-vault store
 * outside the vault. Nothing in the public shapes may carry a hidden value.
 */

export type { Digest };
export type JsonScalar = string | number | boolean | null;
export type FieldType = ObsidianContractType;
export type VariableKind = "date" | "datetime" | "title" | "free";

export interface PublicField {
  readonly name: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly description: string;
}

export interface PublicTemplate {
  /** Vault-relative template source path. */
  readonly id: string;
  /** Basename of the source, without the `.md` extension. */
  readonly name: string;
  readonly applyFolder: string | null;
  readonly fields: readonly PublicField[];
  readonly requiredHeadings: readonly string[];
  readonly sourceHash: Digest;
  /** Random. Never derived from hidden rules. */
  readonly sealId: string;
}

export interface PublicCommon {
  readonly fields: readonly PublicField[];
  readonly sealId: string;
}

export interface PublicManifest {
  readonly version: 1;
  readonly common: PublicCommon | null;
  /** Code-point sorted by id. */
  readonly templates: readonly PublicTemplate[];
}

export type HiddenRule =
  | { readonly kind: "allowed"; readonly values: readonly JsonScalar[] }
  | { readonly kind: "fixed"; readonly value: JsonScalar }
  | { readonly kind: "pattern"; readonly regex: string }
  | { readonly kind: "range"; readonly min?: number | string; readonly max?: number | string };

export interface SealedField extends PublicField {
  readonly rules: readonly HiddenRule[];
  readonly variable: VariableKind | null;
}

/** Raw interview answers, kept only in the hidden store so a re-interview can diff. */
export type InterviewAnswers = Readonly<Record<string, string>>;

export interface SealedLayer {
  readonly sealId: string;
  readonly fields: readonly SealedField[];
  readonly requiredHeadings: readonly string[];
  readonly applyFolder: string | null;
  /** Null for the common layer. */
  readonly sourcePath: string | null;
  readonly sourceHash: Digest | null;
  readonly answers: InterviewAnswers;
}

export type ViolationKind =
  | "yaml-syntax"
  | "path-unsafe"
  | "path-required"
  | "outside-vault"
  | "outside-apply-folder"
  | "required"
  | "type"
  | "not-allowed"
  | "not-fixed"
  | "pattern"
  | "range"
  | "unsubstituted-variable"
  | "heading-missing"
  | "contract-unreadable"
  | "template-unknown"
  | "template-ambiguous"
  | "exists";

/** Names a field (or a public heading) and a kind. Never a hidden value. */
export interface Violation {
  readonly field: string | null;
  readonly kind: ViolationKind;
}

export const FIELD_TYPES: readonly FieldType[] = [
  "text", "string", "select", "number", "boolean", "checkbox", "date", "datetime",
  "list", "multitext", "multi", "tags", "aliases", "file",
];

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Code-point order, independent of locale. */
export function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
