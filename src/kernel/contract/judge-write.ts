import { readFile, realpath } from "node:fs/promises";
import { parseNote } from "../conventions/frontmatter.js";
import { resolveRealTarget, vaultRelative, verifyVaultPath } from "../vault/paths.js";
import { basePathKind, judge } from "./judge.js";
import { resolveSealState } from "./vault-id.js";
import { findingsOf, verdictOf, type ContractView, type Verdict, type Violation, type ViolationKind } from "./types.js";
import { resolveTiers, type GapFinding, type Resolution } from "../write/ambiguity.js";

/**
 * The one entry both write surfaces use. MCP `write` and the Claude hook translator
 * resolve the target here and decide through `decideWrite`, so both paths build the same
 * `JudgeInput` and meet the same tiers: only a refusal stops a write.
 */

export interface ContentInput {
  readonly path: string;
  readonly content: string;
}

/**
 * Parses raw content first; malformed frontmatter is a `yaml-syntax` warning after path
 * rules. A tampered seal still refuses, and an open or broken one still says so.
 */
export function judgeContent(input: ContentInput, view: ContractView): Verdict {
  const pathKind = basePathKind(input.path);
  if (pathKind !== null) return verdictOf([{ field: "path", kind: pathKind }]);
  const parsed = parseNote(input.content);
  if (parsed.diagnostics.length > 0) {
    const posture = view.state === "sealed" ? [] : findingsOf(judge({ path: input.path, frontmatter: {}, body: "" }, view));
    return verdictOf([...posture, { field: "content", kind: "yaml-syntax" }]);
  }
  return judge({ path: input.path, frontmatter: parsed.frontmatter, body: parsed.body }, view);
}

export type WriteTarget =
  | { readonly state: "denied"; readonly verdict: Verdict }
  | {
    readonly state: "ready";
    readonly vaultRoot: string;
    /** Vault-relative path of the target. */
    readonly path: string;
    readonly absolutePath: string;
    /** Current file content; `undefined` for a new file, `null` when the file exists but could not be read. */
    readonly previousContent: string | undefined | null;
    readonly view: ContractView;
  };

function pathDenied(kind: ViolationKind): WriteTarget {
  return { state: "denied", verdict: verdictOf([{ field: "path", kind }]) };
}

export interface WriteTargetDeps {
  readonly resolveSealState?: typeof resolveSealState;
}

/**
 * Resolves `target` (absolute or relative to the vault) and applies the base path rules.
 * Read-only: nothing is created or repaired. A seal state that cannot be resolved is
 * reported as a broken contract: the write goes ahead with a warning instead of the
 * caller seeing an exception.
 */
export async function resolveWriteTarget(vault: string, target: string, deps: WriteTargetDeps = {}): Promise<WriteTarget> {
  let vaultRoot: string;
  let relativePath: string | null;
  try {
    vaultRoot = await realpath(vault);
    relativePath = vaultRelative(vaultRoot, await resolveRealTarget(target, vaultRoot));
  } catch {
    return pathDenied("path-unsafe");
  }
  if (relativePath === null) return pathDenied("outside-vault");
  const pathKind = basePathKind(relativePath);
  if (pathKind !== null) return pathDenied(pathKind);
  let absolutePath: string;
  let exists: boolean;
  try {
    const verified = await verifyVaultPath(vaultRoot, relativePath, { expected: "either" });
    absolutePath = verified.absolutePath;
    exists = verified.targetRealPath !== null;
  } catch {
    return pathDenied("path-unsafe");
  }
  let previousContent: string | undefined | null;
  try {
    previousContent = exists ? await readFile(absolutePath, "utf8") : undefined;
  } catch {
    previousContent = null;
  }
  let view: ContractView;
  try {
    view = (await (deps.resolveSealState ?? resolveSealState)(vaultRoot)).view;
  } catch {
    view = { state: "unreadable", reason: "broken" };
  }
  return { state: "ready", vaultRoot, path: relativePath, absolutePath, previousContent, view };
}

type ReadyTarget = Extract<WriteTarget, { readonly state: "ready" }>;

/** An existing target that cannot be read gives no previous content: the write is judged as new and says so. */
const UNREADABLE_TARGET: Violation = { field: "content", kind: "contract-unreadable" };

/** Judges `content` for an already resolved target; the note on disk never changes the verdict. */
export function judgeReadyTarget(resolved: ReadyTarget, content: string): Verdict {
  const verdict = judgeContent({ path: resolved.path, content }, resolved.view);
  if (resolved.previousContent !== null || verdict.refusals.length > 0) return verdict;
  return verdictOf([...findingsOf(verdict), UNREADABLE_TARGET], verdict.missingDefaults);
}

/** Judges a write of `content` to `target` against the vault's seal state. */
export async function judgeWrite(vault: string, target: string, content: string): Promise<Verdict> {
  const resolved = await resolveWriteTarget(vault, target);
  if (resolved.state === "denied") return resolved.verdict;
  return judgeReadyTarget(resolved, content);
}

export interface DecideWriteOptions {
  /**
   * The selected template, used only to tell whether a scaffold choice is still open (②).
   * It is never judged: the verdict is the same with or without it.
   */
  readonly template?: string | undefined;
  /**
   * False when the caller can only allow or deny the content as written (the Claude hook):
   * nothing is fixed or drafted, and the warnings are recorded as kept.
   */
  readonly repair?: boolean;
  /** The time an unconstrained date or datetime default takes on a new note; without it none is filled. */
  readonly now?: Date | undefined;
}

export type WriteDecision =
  | { readonly outcome: "deny"; readonly verdict: Verdict }
  /** `fixedContent` is present when OMS changed the note; `saved` is the verdict on what is saved. */
  | { readonly outcome: "allow"; readonly verdict: Verdict; readonly saved: Verdict; readonly fixedContent?: string; readonly findings: readonly GapFinding[] }
  /** `asWritten` are the findings to record when the draft cannot be kept and the note is saved as written. */
  | { readonly outcome: "draft"; readonly verdict: Verdict; readonly findings: readonly GapFinding[]; readonly asWritten: readonly GapFinding[] };

/**
 * Judges `content` and decides the tier. Only refusals deny. Warnings are compared with
 * the verdict on the note as it is now: a `(field, kind)` the note already had is not
 * recorded again. A new note or an unreadable one has no baseline, so every warning is new.
 * The verdict always carries the full warning set for the response.
 */
export function decideWrite(resolved: ReadyTarget, content: string, options: DecideWriteOptions = {}): WriteDecision {
  const { template } = options;
  const verdict = judgeReadyTarget(resolved, content);
  // The judge is stateless; the delta is taken here, against its verdict on the note as it is now.
  const baseline = typeof resolved.previousContent === "string"
    ? judgeContent({ path: resolved.path, content: resolved.previousContent }, resolved.view)
    : undefined;
  const resolution: Resolution = resolveTiers({
    view: resolved.view,
    path: resolved.path,
    content,
    template,
    previousContent: resolved.previousContent ?? undefined,
    isNew: resolved.previousContent === undefined,
    now: options.now,
    verdict,
    ...(baseline === undefined ? {} : { baseline }),
    ...(options.repair === undefined ? {} : { repair: options.repair }),
    rejudge: repaired => judgeReadyTarget(resolved, repaired),
  });
  switch (resolution.action) {
    case "refuse":
      return { outcome: "deny", verdict };
    case "draft":
      return { outcome: "draft", verdict, findings: resolution.findings, asWritten: resolution.asWritten };
    case "save":
      return {
        outcome: "allow",
        verdict,
        saved: resolution.verdict,
        ...(resolution.content === content ? {} : { fixedContent: resolution.content }),
        findings: resolution.findings,
      };
  }
}
