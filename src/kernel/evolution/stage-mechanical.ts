import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compareCodePoints } from "../conventions/canonical.js";
import { parseNote } from "../conventions/frontmatter.js";
import { managedSourceExclusionMatcher } from "../conventions/note-exclude.js";
import { mapWithConcurrency, walkVaultMarkdown } from "../conventions/vault-walk.js";
import { basePathKind, judge } from "../contract/judge.js";
import { verdictOf, type VaultContract, type Verdict, type Violation } from "../contract/types.js";

/**
 * Stage 1 of the evaluator: re-judge every note of the vault under the parent and the
 * candidate contract, read-only. It is a hard gate: a candidate that makes the judge
 * refuse a note it did not refuse before is rejected. The warning delta is the score:
 * a candidate that adds warnings is never sealed without the owner (awaiting-human).
 *
 * Content is judged the way a write judges it (path rules, then YAML, then the judge),
 * without importing the write kernel.
 */

const READ_CONCURRENCY = 16;

export interface NoteDelta {
  readonly path: string;
  readonly newRefusals: readonly Violation[];
  readonly newWarnings: readonly Violation[];
}

export interface MechanicalResult {
  readonly scannedNotes: number;
  /** Refusal findings the candidate adds over the parent, summed over notes. */
  readonly newRefusals: number;
  readonly parentWarnings: number;
  readonly candidateWarnings: number;
  /** `candidateWarnings - parentWarnings`: negative when the candidate clears warnings. */
  readonly warningDelta: number;
  /** Stage 1 passes when the candidate adds no refusal. */
  readonly passed: boolean;
  /** Notes whose findings got worse, in code-point path order: `{field, kind}` only. */
  readonly notes: readonly NoteDelta[];
}

/** The judge is injectable so the refusal gate is testable; production always uses `judge`. */
export type NoteJudge = typeof judge;

function judgeNote(path: string, content: string | null, contract: VaultContract, judgeOf: NoteJudge): Verdict {
  const pathKind = basePathKind(path);
  if (pathKind !== null) return verdictOf([{ field: "path", kind: pathKind }]);
  if (content === null) return verdictOf([{ field: "path", kind: "path-unsafe" }]);
  const parsed = parseNote(content);
  if (parsed.diagnostics.length > 0) return verdictOf([{ field: "content", kind: "yaml-syntax" }]);
  return judgeOf({ path, frontmatter: parsed.frontmatter, body: parsed.body }, { state: "sealed", contract });
}

function added(before: readonly Violation[], after: readonly Violation[]): Violation[] {
  const seen = new Set(before.map(finding => `${finding.kind}\u0000${finding.field}`));
  return after.filter(finding => !seen.has(`${finding.kind}\u0000${finding.field}`));
}

async function notePaths(vault: string): Promise<string[]> {
  let managed: (notePath: string) => Promise<boolean> = async () => false;
  try {
    managed = await managedSourceExclusionMatcher(vault);
  } catch {
    // Unreadable exclusion settings exclude nothing: every note is judged.
  }
  const paths: string[] = [];
  for await (const notePath of walkVaultMarkdown(vault)) {
    if (!await managed(notePath)) paths.push(notePath);
  }
  return paths.sort(compareCodePoints);
}

export async function mechanicalStage(
  vault: string,
  parent: VaultContract,
  candidate: VaultContract,
  judgeOf: NoteJudge = judge,
): Promise<MechanicalResult> {
  const paths = await notePaths(vault);
  const judged = await mapWithConcurrency(paths, READ_CONCURRENCY, async (path) => {
    let content: string | null;
    try {
      content = await readFile(join(vault, path), "utf8");
    } catch {
      content = null;
    }
    return { path, before: judgeNote(path, content, parent, judgeOf), after: judgeNote(path, content, candidate, judgeOf) };
  });
  let newRefusals = 0;
  let parentWarnings = 0;
  let candidateWarnings = 0;
  const notes: NoteDelta[] = [];
  for (const { path, before, after } of judged) {
    const refusals = added(before.refusals, after.refusals);
    const warnings = added(before.warnings, after.warnings);
    newRefusals += refusals.length;
    parentWarnings += before.warnings.length;
    candidateWarnings += after.warnings.length;
    if (refusals.length > 0 || warnings.length > 0) notes.push({ path, newRefusals: refusals, newWarnings: warnings });
  }
  return {
    scannedNotes: paths.length,
    newRefusals,
    parentWarnings,
    candidateWarnings,
    warningDelta: candidateWarnings - parentWarnings,
    passed: newRefusals === 0,
    notes,
  };
}
