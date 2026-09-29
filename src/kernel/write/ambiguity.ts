import { compareCodePoints } from "../conventions/canonical.js";
import { parseNote } from "../conventions/frontmatter.js";
import { contractContradictions } from "../contract/contradiction.js";
import type { GapAxis, GapKind, GapWant } from "../contract/gap-ledger.js";
import { insideApplyFolder } from "../contract/judge.js";
import { templatedContract, type TemplatedContract } from "../contract/legacy.js";
import type { ContractView, JsonScalar, Verdict, Violation, ViolationKind } from "../contract/types.js";
import { coerceFrontmatter, writtenValues } from "./coerce.js";

/**
 * What a write does where the note and the sealed contract do not line up exactly.
 * Templates generate; the axes judge. Only a refusal (vault boundary, path safety, a
 * tampered seal) stops a write; every other finding is a warning, and only warnings the
 * note did not already have are recorded. There are three tiers:
 *
 * F fixed: a lossless fix (`coerce`) turns the written value into the one the rule asks
 *   for without losing anything, such as `"12"` into `12` for a number. The fixed form
 *   is saved and each fix is recorded with the value as written. `conform` has already
 *   filled date and title variables, defaults and the heading skeleton; the receipt lists those.
 * W kept: anything else outside the rules, such as an unknown key or a value no allowed
 *   value spells, is saved as written and recorded as `kept`. A warning on a field the
 *   contract itself contradicts is recorded with the reason `contradiction`.
 * D drafted: frontmatter that does not parse cannot be saved as a note the judge reads.
 *   It is kept as a draft beside the ledger and the gap points at it.
 *
 * A multi-template folder with no template selected records a choice beside any tier.
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
  /** False when only the content as written can be saved: nothing is fixed or drafted. */
  readonly repair?: boolean | undefined;
  /** True when the target does not exist; an unreadable previous note is not new. */
  readonly isNew?: boolean | undefined;
  /** The time an unconstrained date default takes on a new note; without it no date is filled. */
  readonly now?: Date | undefined;
  /** The same judge the pipeline used, run again on a fixed form. */
  readonly rejudge: (content: string) => Verdict;
}

export type Resolution =
  /** F or W: save `content`, judged by `verdict` (whose `fixes` lists what was fixed), and record `findings`. */
  | { readonly action: "save"; readonly content: string; readonly verdict: Verdict; readonly findings: readonly GapFinding[] }
  /**
   * D, malformed frontmatter: keep the note as a draft and record `findings` against it.
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

function templatesFor(contract: TemplatedContract, notePath: string): readonly string[] {
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
export function templateChoices(contract: TemplatedContract, notePath: string, template: string | undefined, frontmatter: Readonly<Record<string, unknown>>): GapFinding[] {
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

function findingKey(finding: Violation): string {
  return `${finding.field}\u0000${finding.kind}`;
}

/** A warning is new unless the previous note already had the same `(field, kind)`. */
function newWarnings(verdict: Verdict, baseline: Verdict | undefined): readonly Violation[] {
  const before = new Set((baseline?.warnings ?? []).map(findingKey));
  return verdict.warnings.filter(warning => gapAxisOf(warning.kind) !== null && !before.has(findingKey(warning)));
}

/** The same reading of a note's frontmatter a finding records, before any fix. */
function recorded(warning: Violation, kind: GapKind, frontmatter: Readonly<Record<string, unknown>>, reason: string): GapFinding {
  return { axis: gapAxisOf(warning.kind)!, kind, chosen: null, wanted: want(warning.field, frontmatter), reason: `${reason}: ${warning.kind}` };
}

/** A fix can uncover the next one (a filled list meets its count), so passes repeat a few times. */
const FIX_PASSES = 3;

/**
 * Decides the tier of a judged write: refuse only on a refusal, draft only malformed
 * frontmatter, otherwise fix what is lossless and keep the rest. Recorded findings cover
 * only the warnings the note did not already have.
 */
export function resolveTiers(input: AmbiguityInput): Resolution {
  const { view, verdict } = input;
  if (verdict.refusals.length > 0) return { action: "refuse", reason: "refused" };
  if (view.state !== "sealed") return { action: "save", content: input.content, verdict, findings: [] };
  // The tier is decided on the sealed axes alone; an older generation's templates never
  // constrain a write, so neither contradictions nor fixes read them.
  const contract = view.contract;
  const parsed = parseNote(input.content);
  // A finding records the value as written: `01234` stays `01234`, not the number it parses to.
  const frontmatter = writtenValues(input.content);
  // slice f2: move to templateFolder
  const choices = parsed.diagnostics.length > 0 ? [] : templateChoices(templatedContract(view), input.path, input.template, parsed.frontmatter);
  const gaps = newWarnings(verdict, input.baseline);
  if (gaps.length === 0) return { action: "save", content: input.content, verdict, findings: choices };

  const contradicted = new Set(contractContradictions({ ...contract, templates: {} }).map(entry => entry.field));
  const keep = (warnings: readonly Violation[]) => warnings.map(warning =>
    recorded(warning, "kept", frontmatter, contradicted.has(warning.field) ? "contradiction" : "kept"));
  if (gaps.some(warning => warning.kind === "yaml-syntax")) {
    return {
      action: "draft",
      findings: [...choices, ...gaps.map(warning => recorded(warning, "no-fit", frontmatter, "drafted"))],
      asWritten: [...choices, ...keep(gaps)],
    };
  }
  if (input.repair === false) return { action: "save", content: input.content, verdict, findings: [...choices, ...keep(gaps)] };

  let content = input.content;
  let current = verdict;
  let remaining = gaps;
  const fixes: Violation[] = [];
  const skip = new Set(contradicted);
  for (let pass = 0; pass < FIX_PASSES && remaining.length > 0; pass += 1) {
    const coerced = coerceFrontmatter(content, remaining, { contract, isNew: input.isNew === true, now: input.now }, skip);
    if (coerced === null) break;
    const next = input.rejudge(coerced.content);
    if (next.refusals.length > 0) break;
    // A fix counts only when the rejudged note no longer reports it; a pass with a fix
    // that did not clear is not saved, and that field is kept as written from then on.
    const after = new Set(next.warnings.map(findingKey));
    const uncleared = coerced.fixes.filter(fix => after.has(findingKey(fix)));
    if (uncleared.length > 0) {
      for (const fix of uncleared) skip.add(fix.field);
      continue;
    }
    content = coerced.content;
    current = next;
    fixes.push(...coerced.fixes);
    remaining = newWarnings(next, input.baseline);
  }
  const fixedFindings = fixes.map(fix => recorded(fix, "fixed", frontmatter, "fixed"));
  return {
    action: "save",
    content,
    verdict: { ...current, fixes },
    findings: [...choices, ...fixedFindings, ...keep(remaining)],
  };
}
