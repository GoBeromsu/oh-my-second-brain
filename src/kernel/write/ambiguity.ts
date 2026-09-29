import { isMap, parseDocument } from "yaml";
import { compareCodePoints } from "../conventions/canonical.js";
import { parseNote } from "../conventions/frontmatter.js";
import { contractContradictions } from "../contract/contradiction.js";
import type { GapAxis, GapKind, GapWant } from "../contract/gap-ledger.js";
import { insideApplyFolder } from "../contract/judge.js";
import type { ContractView, JsonScalar, VaultContract, Verdict, Violation, ViolationKind } from "../contract/types.js";

/**
 * What a write does where the note and the sealed contract do not line up exactly. Only a
 * refusal (vault boundary, path safety, a tampered seal) stops a write; everything below
 * is a warning, and only warnings the note did not already have are recorded. There are
 * four kinds:
 *
 * ① mechanical: `conform` fills date and title variables, defaults and the heading
 *    skeleton before the judge runs. Nothing is recorded; the receipt lists the changes.
 * ② choice: the frame leaves a choice open (several templates apply to the folder and
 *    none was selected). The note is saved as written and the choice is recorded.
 * ③ gap: the note wants something the frame has no place for. When dropping only the
 *    unplaceable frontmatter keys gives a form the same judge accepts, that nearest valid
 *    form is saved and each dropped want is recorded. Otherwise nothing is saved in the
 *    vault; the note is kept as a draft beside the ledger and the gaps point at it.
 *    Malformed frontmatter is always drafted.
 * ④ contradiction: the contract itself cannot be satisfied on the field. The note is
 *    saved as written and each warning is recorded with the reason `contradiction`.
 *
 * An open or broken contract has no ledger: the note is saved as written with its warning.
 *
 * This module decides and never writes; the pipeline records and saves.
 */

export interface GapFinding {
  readonly axis: GapAxis;
  readonly kind: GapKind;
  readonly chosen: string | null;
  readonly wanted: GapWant;
  readonly reason: string;
}

export interface AmbiguityInput {
  readonly view: ContractView;
  /** Vault-relative note path. */
  readonly path: string;
  /** The content the judge saw, after `conform`. */
  readonly content: string;
  readonly template?: string | undefined;
  /** The note on disk before this write; undefined for a new note. */
  readonly previousContent?: string | undefined;
  readonly verdict: Verdict;
  /** The verdict on `previousContent`; absent when there is no readable previous note. */
  readonly baseline?: Verdict | undefined;
  /** False when only the content as written can be saved: nothing is dropped or drafted. */
  readonly repair?: boolean | undefined;
  /** The same judge the pipeline used, run again on a repaired form. */
  readonly rejudge: (content: string) => Verdict;
}

export type Resolution =
  /** ①, ②, a repaired ③ or ④: save `content`, judged by `verdict`, and record `findings`. */
  | { readonly action: "save"; readonly content: string; readonly verdict: Verdict; readonly findings: readonly GapFinding[] }
  /**
   * ③ with no valid form: keep the note as a draft and record `findings` against it.
   * `asWritten` is what to record instead when no draft can be kept and the note is saved as written.
   */
  | { readonly action: "draft"; readonly findings: readonly GapFinding[]; readonly asWritten: readonly GapFinding[] }
  /** The verdict carries a refusal. */
  | { readonly action: "refuse"; readonly reason: "refused" };

const AXIS_OF: Readonly<Partial<Record<ViolationKind, GapAxis>>> = {
  "unregistered-folder": "folder",
  "unknown-property": "property",
  "missing": "property",
  "type": "value",
  "not-allowed": "value",
  "not-fixed": "value",
  "pattern": "value",
  "range": "value",
  "count": "value",
  "unsubstituted-variable": "value",
  "yaml-syntax": "value",
};

/** Kinds a key can be dropped for: the key or its value has no place in the frame. */
const DROPPABLE: ReadonlySet<ViolationKind> = new Set([
  "unknown-property", "type", "not-allowed", "not-fixed", "pattern", "range", "count", "unsubstituted-variable",
]);

/** The ledger axis a violation belongs to, or null when the violation is not a gap in the frame. */
export function gapAxisOf(kind: ViolationKind): GapAxis | null {
  return AXIS_OF[kind] ?? null;
}

function scalar(value: unknown): value is JsonScalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/** The wanted value when it is plain data; anything else is recorded by field only. */
function want(field: string, frontmatter: Readonly<Record<string, unknown>>): GapWant {
  if (!Object.hasOwn(frontmatter, field)) return { field };
  const value = frontmatter[field];
  if (scalar(value)) return { field, value };
  if (Array.isArray(value) && value.every(scalar)) return { field, value };
  return { field };
}

function templatesFor(contract: VaultContract, notePath: string): readonly string[] {
  return Object.entries(contract.templates)
    .filter(([, template]) => template.applyFolder !== undefined && insideApplyFolder(notePath, template.applyFolder))
    .map(([name]) => name)
    .sort(compareCodePoints);
}

/**
 * ② A note saved into a folder several templates apply to, with no template selected.
 * The recommendation is the first template (code point order) whose required properties
 * the note already carries, or null when none fits yet.
 */
export function templateChoices(contract: VaultContract, notePath: string, template: string | undefined, frontmatter: Readonly<Record<string, unknown>>): GapFinding[] {
  if (template !== undefined) return [];
  const candidates = templatesFor(contract, notePath);
  if (candidates.length < 2) return [];
  const recommended = candidates.find(name => contract.templates[name]!.requiredProperties.every(property => Object.hasOwn(frontmatter, property))) ?? null;
  return [{
    axis: "template",
    kind: "choice",
    chosen: recommended,
    // The candidates, never note content: they key the choice so a repeat is recorded once.
    wanted: { field: "template", value: candidates },
    reason: `${candidates.length} templates apply to the folder and none was selected`,
  }];
}

function requiredBy(contract: VaultContract, field: string): boolean {
  return contract.properties !== null && Object.hasOwn(contract.properties, field) && contract.properties[field]!.required;
}

/**
 * The frontmatter keys whose removal could clear every violation, or null when some
 * violation cannot be cleared that way. A key the note already had before this write is
 * never dropped, so a repair only ever removes what this write added.
 */
function droppableKeys(violations: readonly Violation[], contract: VaultContract, input: AmbiguityInput, frontmatter: Readonly<Record<string, unknown>>): readonly string[] | null {
  const before = input.previousContent === undefined ? {} : parseNote(input.previousContent).frontmatter;
  const keys = new Set<string>();
  for (const violation of violations) {
    if (!DROPPABLE.has(violation.kind) || !Object.hasOwn(frontmatter, violation.field)) return null;
    if (Object.hasOwn(before, violation.field) || requiredBy(contract, violation.field)) return null;
    keys.add(violation.field);
  }
  return keys.size === 0 ? null : [...keys].sort(compareCodePoints);
}

/** `content` without the frontmatter `keys`; the body and every other key stay as written. */
export function dropFrontmatterKeys(content: string, keys: readonly string[]): string | null {
  const parsed = parseNote(content);
  if (parsed.frontmatterRange === null || parsed.diagnostics.length > 0) return null;
  const document = parseDocument(parsed.frontmatterRaw, { uniqueKeys: true });
  if (!isMap(document.contents)) return null;
  for (const key of keys) document.delete(key);
  // A fence around nothing does not parse as frontmatter, so an emptied block goes entirely.
  if (document.contents.items.length === 0) return parsed.body;
  const yaml = String(document);
  const head = content.slice(0, parsed.frontmatterRange.start);
  const tail = content.slice(parsed.frontmatterRange.end);
  return `${head}${yaml.endsWith("\n") ? yaml : `${yaml}\n`}${tail.replace(/^\r?\n/, "")}`;
}

function noFit(violation: Violation, axis: GapAxis, frontmatter: Readonly<Record<string, unknown>>, reason: string): GapFinding {
  return { axis, kind: "no-fit", chosen: null, wanted: want(violation.field, frontmatter), reason };
}

function findingKey(finding: Violation): string {
  return `${finding.field}\u0000${finding.kind}`;
}

/** A warning is new unless the previous note already had the same `(field, kind)`. */
function newWarnings(verdict: Verdict, baseline: Verdict | undefined): readonly Violation[] {
  const before = new Set((baseline?.warnings ?? []).map(findingKey));
  return verdict.warnings.filter(warning => gapAxisOf(warning.kind) !== null && !before.has(findingKey(warning)));
}

/**
 * Decides the tier of a judged write: refuse only on a refusal, otherwise save, repair or
 * draft. Recorded findings cover only the warnings the note did not already have.
 */
export function resolveTiers(input: AmbiguityInput): Resolution {
  const { view, verdict } = input;
  if (verdict.refusals.length > 0) return { action: "refuse", reason: "refused" };
  if (view.state !== "sealed") return { action: "save", content: input.content, verdict, findings: [] };
  const { contract } = view;
  const parsed = parseNote(input.content);
  const frontmatter = parsed.frontmatter;
  const choices = parsed.diagnostics.length > 0 ? [] : templateChoices(contract, input.path, input.template, frontmatter);
  const gaps = newWarnings(verdict, input.baseline);
  if (gaps.length === 0) return { action: "save", content: input.content, verdict, findings: choices };

  const recorded = (reason: string) => gaps.map(warning => noFit(warning, gapAxisOf(warning.kind)!, frontmatter, `${reason}: ${warning.kind}`));
  const contradicted = new Set(contractContradictions(contract).map(entry => entry.field));
  if (gaps.some(warning => contradicted.has(warning.field))) {
    return { action: "save", content: input.content, verdict, findings: [...choices, ...recorded("contradiction")] };
  }
  const asWritten = [...choices, ...recorded("kept")];
  if (input.repair === false) return { action: "save", content: input.content, verdict, findings: asWritten };

  const keys = droppableKeys(gaps, contract, input, frontmatter);
  const repaired = keys === null ? null : dropFrontmatterKeys(input.content, keys);
  if (repaired !== null) {
    const second = input.rejudge(repaired);
    if (second.refusals.length === 0 && newWarnings(second, input.baseline).length === 0) {
      return { action: "save", content: repaired, verdict: second, findings: [...choices, ...recorded("dropped")] };
    }
  }
  return { action: "draft", findings: [...choices, ...recorded("drafted")], asWritten };
}
