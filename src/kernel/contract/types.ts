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
  | { readonly kind: "range"; readonly min?: number | string; readonly max?: number | string }
  /** How many members the value has: a list counts its items, anything else counts as one. */
  | { readonly kind: "count"; readonly min?: number; readonly max?: number };

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

/**
 * A template entry of a version 1 or 2 generation. New generations never store one; an
 * old one is read into `ContractView.legacy` for doctor reporting and never judged.
 */
export interface LegacyTemplateContract {
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

/** Null axis = open (nothing sealed for it). */
export interface VaultContract {
  readonly folders: Readonly<Record<string, FolderContract>> | null;
  readonly properties: Readonly<Record<string, PropertyContract>> | null;
}

/** What an old generation sealed beyond folders and properties, projected on load and never persisted. Templates are keyed by name. */
export interface LegacyContract {
  readonly templates: Readonly<Record<string, LegacyTemplateContract>>;
}

export interface JudgeInput {
  /** Vault-relative note path. */
  readonly path: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
}

export type ViolationKind =
  | "control-path"
  | "yaml-syntax"
  | "path-unsafe"
  | "outside-vault"
  | "contract-unreadable"
  | "contract-tampered"
  | "contract-open"
  | "unregistered-folder"
  | "unknown-property"
  | "missing"
  | "type"
  | "not-allowed"
  | "not-fixed"
  | "pattern"
  | "range"
  | "count"
  | "unsubstituted-variable"
  | "unsupported-input";

export const VIOLATION_KINDS: readonly ViolationKind[] = [
  "control-path", "yaml-syntax", "path-unsafe", "outside-vault", "contract-unreadable",
  "contract-tampered", "contract-open", "unregistered-folder", "unknown-property", "missing",
  "type", "not-allowed", "not-fixed", "pattern", "range", "count", "unsubstituted-variable",
  "unsupported-input",
];

/**
 * `field` is `path`, `contract`, `content`, a property key or an input key. It never carries
 * a value or a pattern. The judge's own fields never name a template; other `{field, kind}`
 * reports, such as reseal loosening changes, may carry a template name, which is
 * vault-visible, never a sealed value.
 */
export interface Violation {
  readonly field: string;
  readonly kind: ViolationKind;
}

/**
 * How a kind stops a write. Only safety refuses: the vault boundary and path safety, a
 * tampered vault id, and input the kernel cannot read. Every other kind lets the write
 * through with a warning.
 */
export type Severity = "refuse" | "warn";

/** Total: exactly one severity per kind. */
export const SEVERITY_OF: Readonly<Record<ViolationKind, Severity>> = {
  "control-path": "refuse",
  "yaml-syntax": "warn",
  "path-unsafe": "refuse",
  "outside-vault": "refuse",
  "contract-unreadable": "warn",
  "contract-tampered": "refuse",
  "contract-open": "warn",
  "unregistered-folder": "warn",
  "unknown-property": "warn",
  "missing": "warn",
  "type": "warn",
  "not-allowed": "warn",
  "not-fixed": "warn",
  "pattern": "warn",
  "range": "warn",
  "count": "warn",
  "unsubstituted-variable": "warn",
  // Malformed input refuses; the hook reports a content it cannot rebuild as a warning itself.
  "unsupported-input": "refuse",
};

/**
 * `ok` is true exactly when nothing refuses. `violations` is the deprecated name for
 * `refusals`, kept so older readers still see what stopped a write. `fixes` lists the
 * lossless fixes a write applied, as `{field, kind}` of the warning each one cleared. The
 * judge itself never fixes, so a verdict straight from the judge has none; the verdict on
 * the note a write saves (and the write receipt and check built from it) lists them, and
 * its `warnings` are what remains after the fixes.
 */
export interface Verdict {
  readonly ok: boolean;
  readonly refusals: readonly Violation[];
  readonly warnings: readonly Violation[];
  readonly fixes: readonly Violation[];
  readonly missingDefaults: readonly string[];
  /** @deprecated The same list as `refusals`. */
  readonly violations: readonly Violation[];
}

/** Splits findings by severity into a verdict. */
export function verdictOf(findings: readonly Violation[], missingDefaults: readonly string[] = []): Verdict {
  const refusals = findings.filter(finding => SEVERITY_OF[finding.kind] === "refuse");
  const warnings = findings.filter(finding => SEVERITY_OF[finding.kind] === "warn");
  return { ok: refusals.length === 0, refusals, warnings, fixes: [], missingDefaults, violations: refusals };
}

/** Every finding of a verdict, refusals first: what `doctor audit` reports. */
export function findingsOf(verdict: Verdict): readonly Violation[] {
  return [...verdict.refusals, ...verdict.warnings];
}

/** The only command names agent-facing output may contain. */
export const GUIDANCE = [
  "oms doctor contract",
  "oms doctor contract --fix",
  "oms doctor status",
  "oms setup host sync",
  "oms setup",
  "oms interview",
] as const;
export type Guidance = (typeof GUIDANCE)[number];

/** Total: exactly one guidance per kind. */
export const GUIDANCE_FOR: Readonly<Record<ViolationKind, Guidance>> = {
  "control-path": "oms doctor status",
  "yaml-syntax": "oms doctor status",
  "path-unsafe": "oms doctor status",
  "outside-vault": "oms doctor status",
  "contract-unreadable": "oms interview",
  "contract-tampered": "oms doctor contract",
  "contract-open": "oms interview",
  "unregistered-folder": "oms doctor status",
  "unknown-property": "oms doctor status",
  "missing": "oms doctor status",
  "type": "oms doctor status",
  "not-allowed": "oms doctor status",
  "not-fixed": "oms doctor status",
  "pattern": "oms doctor status",
  "range": "oms doctor status",
  "count": "oms doctor status",
  "unsubstituted-variable": "oms doctor status",
  "unsupported-input": "oms setup host sync",
};

function formatFindings(prefix: string, findings: readonly Violation[]): string {
  const list = findings.map(finding => ({ field: finding.field, kind: finding.kind }));
  const guidance = findings.length === 0 ? "oms doctor status" : GUIDANCE_FOR[findings[0]!.kind];
  return `${prefix}${JSON.stringify(list)} Run: ${guidance}`;
}

/** The refusals only. The first picks the one guidance; the reason carries `{field, kind}` only. */
export function formatDenyReason(refusals: readonly Violation[]): string {
  return formatFindings("[oms] write denied: ", refusals);
}

export const WARNING_PREFIX = "[oms] write allowed with warnings: ";

/** The line an allowed write carries: `{field, kind}` and one guidance, never a value or a path. */
export function formatWarnings(warnings: readonly Violation[]): string {
  return formatFindings(WARNING_PREFIX, warnings);
}

/**
 * What the judge sees of a vault's seal: nothing sealed, sealed but unreadable, or the
 * contract. An unreadable seal is `tampered` when the vault's own id disagrees with this
 * machine's record (writes are refused), and `broken` otherwise (writes warn).
 */
export type ContractView =
  | { readonly state: "open" }
  | { readonly state: "unreadable"; readonly reason: "tampered" | "broken" }
  /**
   * `revision` is the manifest digest of the generation the contract was read from; a view
   * built in memory has none. `legacy` is present when that generation is version 1 or 2.
   */
  | { readonly state: "sealed"; readonly contract: VaultContract; readonly revision?: Digest; readonly legacy?: LegacyContract };
