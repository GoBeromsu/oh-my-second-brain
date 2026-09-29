import path from "node:path";
import { parseNote } from "../conventions/frontmatter.js";
import { contractContradictions } from "../contract/contradiction.js";
import type { GapAxis, GapKind, GapWant } from "../contract/gap-ledger.js";
import type { ContractView, JsonScalar, Verdict, Violation, ViolationKind } from "../contract/types.js";
import { coerceFrontmatter, writtenValues } from "./coerce.js";
import { templatesForFolder, type LiveTemplate } from "./live-templates.js";

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
 * A new note in a folder two or more live templates match, with no template selected,
 * records a choice beside any tier.
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
  /** The live templates in `templateFolder`; without them no choice is recorded. */
  readonly templates?: readonly LiveTemplate[] | undefined;
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

/**
 * ② A new note saved into a folder two or more live templates match, with no template
 * selected: nothing is scaffolded. The recommendation is the first template (by name)
 * whose keys the note already carries, or null when none fits yet.
 */
export function templateChoices(templates: readonly LiveTemplate[], notePath: string, template: string | undefined, frontmatter: Readonly<Record<string, unknown>>): GapFinding[] {
  if (template !== undefined) return [];
  const matches = templatesForFolder(templates, path.posix.dirname(notePath));
  if (matches.length < 2) return [];
  const candidates = matches.map(candidate => candidate.name);
  const recommended = matches.find(candidate => candidate.fields.every(field => Object.hasOwn(frontmatter, field.name)))?.name ?? null;
  return [{
    axis: "template",
    kind: "choice",
    chosen: recommended,
    // The candidates, never note content: they key the choice so a repeat is recorded once.
    wanted: { field: "template", value: candidates },
    reason: `${candidates.length} templates match the folder and none was selected`,
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
 * A discarded pass does not use up a fix pass, since each one only adds its fields to the
 * skip set. This caps the attempts anyway, so the loop always ends.
 */
const MAX_ATTEMPTS = 12;

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
  const choices = parsed.diagnostics.length > 0 || input.isNew !== true ? [] : templateChoices(input.templates ?? [], input.path, input.template, parsed.frontmatter);
  const gaps = newWarnings(verdict, input.baseline);
  if (gaps.length === 0) return { action: "save", content: input.content, verdict, findings: choices };

  const contradicted = new Set(contractContradictions(contract).map(entry => entry.field));
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
  let passes = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && passes < FIX_PASSES && remaining.length > 0; attempt += 1) {
    const coerced = coerceFrontmatter(content, remaining, { contract, isNew: input.isNew === true, now: input.now }, skip);
    if (coerced === null) break;
    const next = input.rejudge(coerced.content);
    if (next.refusals.length > 0) break;
    // A fix counts only when the rejudged note no longer reports it; a pass with a fix
    // that did not clear is not saved, and that field is kept as written from then on. A
    // discarded pass does not count toward the fix passes.
    const after = new Set(next.warnings.map(findingKey));
    const uncleared = coerced.fixes.filter(fix => after.has(findingKey(fix)));
    if (uncleared.length > 0) {
      for (const fix of uncleared) skip.add(fix.field);
      continue;
    }
    passes += 1;
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
