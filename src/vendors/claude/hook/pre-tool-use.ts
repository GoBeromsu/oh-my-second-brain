import { homedir } from "node:os";
import path from "node:path";
import { recordGaps, type GapLedgerDeps } from "../../../kernel/contract/gap-ledger.js";
import { judge } from "../../../kernel/contract/judge.js";
import { decideWrite, resolveWriteTarget } from "../../../kernel/contract/judge-write.js";
import { contractRevision } from "../../../kernel/contract/revision.js";
import { storeRoot } from "../../../kernel/contract/store.js";
import { formatDenyReason, formatWarnings, type ContractView, type Verdict, type Violation } from "../../../kernel/contract/types.js";
import { resolveSealState, type SealState } from "../../../kernel/contract/vault-id.js";
import type { GapFinding } from "../../../kernel/write/ambiguity.js";
import { gapInputs } from "../../../kernel/write/pipeline.js";
import { readStdinTimeout, type StdinRead } from "./stdin.js";

/**
 * `oms hook pre`: translates a Claude PreToolUse payload into the note the tool would
 * leave on disk and hands it to the contract judge. Only the judge decides; this layer
 * reconstructs content and formats the answer. Only a refusal denies: a warning allows
 * the write and reaches Claude as a `systemMessage` plus PreToolUse `additionalContext`,
 * with no `permissionDecision`, so Claude's normal permission flow still applies. The hook
 * cannot change what the tool writes, so it never repairs or drafts; the warnings a write
 * adds are recorded in the gap ledger as kept.
 */

export const WRITE_TOOLS = ["write", "edit", "multiedit", "notebookedit"] as const;

export type HookResponse =
  | { readonly continue: true; readonly suppressOutput: true }
  | { readonly systemMessage: string; readonly hookSpecificOutput: { readonly hookEventName: "PreToolUse"; readonly additionalContext: string } }
  | { readonly hookSpecificOutput: { readonly hookEventName: "PreToolUse"; readonly permissionDecision: "deny"; readonly permissionDecisionReason: string } };

export interface HookResult {
  readonly response: HookResponse;
  /** One line for stderr when the payload could not be judged; never names a path or value. */
  readonly warning: string | null;
}

const ALLOW: HookResponse = { continue: true, suppressOutput: true };

function allow(warning: string | null = null): HookResult {
  return { response: ALLOW, warning };
}

function deny(violations: readonly Violation[]): HookResult {
  return {
    response: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: formatDenyReason(violations) } },
    warning: null,
  };
}

function warn(warnings: readonly Violation[]): HookResult {
  const message = formatWarnings(warnings);
  return { response: { systemMessage: message, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: message } }, warning: null };
}

function fromVerdict(verdict: Verdict): HookResult {
  if (!verdict.ok) return deny(verdict.refusals);
  return verdict.warnings.length === 0 ? allow() : warn(verdict.warnings);
}

export interface PreToolUseDeps {
  readonly gapRoot: () => string;
  readonly resolveSealState: (vault: string) => Promise<SealState>;
  readonly gapLedger: Partial<GapLedgerDeps>;
}

/** `~` and `~/rest` expand to the home directory; `~user` forms cannot be resolved and give null. */
function expandHome(target: string): string | null {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return path.join(homedir(), target.slice(2));
  if (target.startsWith("~")) return null;
  return target;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Applies one Claude edit the way the tool does; null when the tool itself would refuse it. */
function applyEdit(base: string | undefined, edit: Record<string, unknown>): string | null {
  const oldString = text(edit["old_string"]);
  const newString = text(edit["new_string"]);
  if (oldString === undefined || newString === undefined) return null;
  if (base === undefined) return oldString === "" ? newString : null;
  if (oldString === "") return null;
  const parts = base.split(oldString);
  const count = parts.length - 1;
  if (count === 0) return null;
  if (edit["replace_all"] === true) return parts.join(newString);
  if (count !== 1) return null;
  return parts.join(newString);
}

function reconstruct(tool: string, input: Record<string, unknown>, previous: string | undefined): string | null {
  if (tool === "write") return text(input["content"]) ?? null;
  if (tool === "edit") return applyEdit(previous, input);
  const edits = input["edits"];
  if (!Array.isArray(edits) || edits.length === 0) return null;
  let current = previous;
  for (const edit of edits) {
    const next = applyEdit(current, record(edit));
    if (next === null) return null;
    current = next;
  }
  return current ?? null;
}

/**
 * Judges one PreToolUse payload for the vault. Never throws. The guard only routes writes
 * inside the vault here, so a payload that is cut off or cannot be parsed is denied.
 */
export async function translatePreToolUse(
  raw: string,
  vault: string,
  transport: Pick<StdinRead, "truncated"> = { truncated: false },
  overrides: Partial<PreToolUseDeps> = {},
): Promise<HookResult> {
  const deps: PreToolUseDeps = { gapRoot: storeRoot, resolveSealState: root => resolveSealState(root), gapLedger: {}, ...overrides };
  if (transport.truncated) return deny([{ field: "input", kind: "unsupported-input" }]);
  let payload: Record<string, unknown>;
  try {
    payload = record(JSON.parse(raw));
  } catch {
    return deny([{ field: "input", kind: "unsupported-input" }]);
  }
  const tool = String(payload["tool_name"] ?? payload["toolName"] ?? "").toLowerCase();
  if (!(WRITE_TOOLS as readonly string[]).includes(tool)) return allow();
  const input = record(payload["tool_input"] ?? payload["toolInput"]);
  const target = text(input["file_path"]) || text(input["notebook_path"]) || text(input["path"]);
  if (!target) return allow();
  const cwd = text(payload["cwd"]) || process.cwd();
  const expanded = expandHome(target);
  if (expanded === null) return deny([{ field: "path", kind: "path-unsafe" }]);

  const read: { seal?: SealState } = {};
  const resolved = await resolveWriteTarget(vault, path.resolve(cwd, expanded), {
    resolveSealState: async root => (read.seal = await deps.resolveSealState(root)),
  });
  if (resolved.state === "denied") {
    return resolved.verdict.refusals.some(violation => violation.kind === "outside-vault") ? allow() : fromVerdict(resolved.verdict);
  }
  if (tool === "notebookedit" || !resolved.path.toLowerCase().endsWith(".md")) return allow();

  // An unreadable existing file has no base to apply an edit to; a full Write still has content.
  const content = resolved.previousContent === null
    ? (tool === "write" ? reconstruct(tool, input, undefined) : null)
    : reconstruct(tool, input, resolved.previousContent);
  if (content === null) return notJudged(resolved.path, resolved.view, resolved.previousContent === null);

  const decision = decideWrite(resolved, content, { repair: false });
  if (decision.outcome === "allow" && decision.findings.length > 0) await recordKept(decision.findings, resolved.path, content, resolved.view, read.seal, deps);
  return fromVerdict(decision.verdict);
}

/**
 * No content to judge: the tool itself refuses an edit that does not apply. The contract's
 * own posture still decides (a tampered seal denies); otherwise the write is allowed and,
 * outside an open vault, Claude is told it was not judged.
 */
function notJudged(notePath: string, view: ContractView, unreadable: boolean): HookResult {
  const posture = judge({ path: notePath, frontmatter: {}, body: "" }, view);
  if (!posture.ok) return deny(posture.refusals);
  if (view.state === "open") return allow("[oms] the edit does not apply to the current file; nothing to judge.");
  // Only the contract's own posture applies; the empty stand-in note has no content to find fault with.
  const contract = posture.warnings.filter((w) => w.field === "contract");
  return warn([...contract, { field: "content", kind: unreadable ? "contract-unreadable" : "unsupported-input" }]);
}

/** Records the warnings a write adds as kept gaps. A ledger that cannot be written never denies the write. */
async function recordKept(
  findings: readonly GapFinding[],
  notePath: string,
  content: string,
  view: ContractView,
  seal: SealState | undefined,
  deps: PreToolUseDeps,
): Promise<void> {
  const revision = contractRevision(view);
  const vaultId = seal?.vaultId ?? null;
  if (revision === null || vaultId === null) return;
  try {
    await recordGaps(deps.gapRoot(), vaultId, gapInputs(findings, notePath, content, revision), deps.gapLedger);
  } catch {
    // The write goes ahead with its warnings; the ledger is advisory here.
  }
}

export async function runPreToolUse(opts: { vault: string }): Promise<void> {
  const read = await readStdinTimeout();
  const result = await translatePreToolUse(read.text, path.resolve(opts.vault), read);
  if (result.warning !== null) process.stderr.write(`${result.warning}\n`);
  process.stdout.write(`${JSON.stringify(result.response)}\n`);
}
