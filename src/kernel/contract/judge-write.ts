import { readFile, realpath } from "node:fs/promises";
import { parseNote } from "../conventions/frontmatter.js";
import { resolveRealTarget, vaultRelative, verifyVaultPath } from "../vault/paths.js";
import { basePathKind, judge } from "./judge.js";
import { resolveSealState } from "./vault-id.js";
import type { ContractView, Verdict, ViolationKind } from "./types.js";

/**
 * The one entry both write surfaces use. MCP `write` and the Claude hook translator
 * resolve the target here and hand the reconstructed note to `judge` through
 * `judgeContent`, so both paths build the same `JudgeInput`.
 */

export interface ContentInput {
  readonly path: string;
  readonly content: string;
  readonly selectedTemplate?: string;
  readonly previousContent?: string;
}

/** Parses raw content first; malformed frontmatter is reported as `yaml-syntax` after path rules. */
export function judgeContent(input: ContentInput, view: ContractView): Verdict {
  const pathKind = basePathKind(input.path);
  if (pathKind !== null) return { ok: false, violations: [{ field: "path", kind: pathKind }], missingDefaults: [] };
  const parsed = parseNote(input.content);
  if (parsed.diagnostics.length > 0) return { ok: false, violations: [{ field: "content", kind: "yaml-syntax" }], missingDefaults: [] };
  return judge({
    path: input.path,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    ...(input.selectedTemplate === undefined ? {} : { selectedTemplate: input.selectedTemplate }),
    ...(input.previousContent === undefined ? {} : { previousContent: input.previousContent }),
  }, view);
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
  return { state: "denied", verdict: { ok: false, violations: [{ field: "path", kind }], missingDefaults: [] } };
}

export interface WriteTargetDeps {
  readonly resolveSealState?: typeof resolveSealState;
}

/**
 * Resolves `target` (absolute or relative to the vault) and applies the base path rules.
 * Read-only: nothing is created or repaired. A seal state that cannot be resolved is
 * reported as an unreadable contract, so the judge fails closed instead of the caller
 * seeing an exception.
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
    view = { state: "unreadable" };
  }
  return { state: "ready", vaultRoot, path: relativePath, absolutePath, previousContent, view };
}

type ReadyTarget = Extract<WriteTarget, { readonly state: "ready" }>;

/** Judges `content` for an already resolved target; an unreadable existing file goes to `unreadableTarget`. */
export function judgeReadyTarget(resolved: ReadyTarget, content: string, selectedTemplate?: string): Verdict {
  if (resolved.previousContent === null) return unreadableTarget(resolved.view);
  return judgeContent({
    path: resolved.path,
    content,
    ...(selectedTemplate === undefined ? {} : { selectedTemplate }),
    ...(resolved.previousContent === undefined ? {} : { previousContent: resolved.previousContent }),
  }, resolved.view);
}

/** Judges a write of `content` to `target` against the vault's seal state. */
export async function judgeWrite(vault: string, target: string, content: string, selectedTemplate?: string): Promise<Verdict> {
  const resolved = await resolveWriteTarget(vault, target);
  if (resolved.state === "denied") return resolved.verdict;
  return judgeReadyTarget(resolved, content, selectedTemplate);
}

/**
 * An existing target that cannot be read gives no previous content to judge against.
 * A sealed or unreadable contract fails closed; an open vault allows the write.
 */
export function unreadableTarget(view: ContractView): Verdict {
  if (view.state === "open") return { ok: true, violations: [], missingDefaults: [] };
  return { ok: false, violations: [{ field: "contract", kind: "contract-unreadable" }], missingDefaults: [] };
}
