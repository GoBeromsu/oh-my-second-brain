import { homedir } from "node:os";
import path from "node:path";
import { judgeReadyTarget, resolveWriteTarget, unreadableTarget } from "../../../kernel/contract/judge-write.js";
import { formatDenyReason, type Verdict, type Violation } from "../../../kernel/contract/types.js";
import { readStdinTimeout, type StdinRead } from "./stdin.js";

/**
 * `oms hook pre`: translates a Claude PreToolUse payload into the note the tool would
 * leave on disk and hands it to the contract judge. Only the judge decides; this layer
 * reconstructs content and formats the answer.
 */

export const WRITE_TOOLS = ["write", "edit", "multiedit", "notebookedit"] as const;

export type HookResponse =
  | { readonly continue: true; readonly suppressOutput: true }
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

function fromVerdict(verdict: Verdict): HookResult {
  if (verdict.ok) return allow();
  return deny(verdict.violations);
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
export async function translatePreToolUse(raw: string, vault: string, transport: Pick<StdinRead, "truncated"> = { truncated: false }): Promise<HookResult> {
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

  const resolved = await resolveWriteTarget(vault, path.resolve(cwd, expanded));
  if (resolved.state === "denied") {
    return resolved.verdict.violations.some(violation => violation.kind === "outside-vault") ? allow() : fromVerdict(resolved.verdict);
  }
  if (tool === "notebookedit" || !resolved.path.toLowerCase().endsWith(".md")) return allow();
  if (resolved.previousContent === null) return fromVerdict(unreadableTarget(resolved.view));

  const content = reconstruct(tool, input, resolved.previousContent);
  if (content === null) {
    // The tool refuses an edit that does not apply; a sealed vault denies it here as well.
    if (resolved.view.state !== "open") return deny([{ field: "content", kind: "unsupported-input" }]);
    return allow("[oms] the edit does not apply to the current file; nothing to judge.");
  }
  return fromVerdict(judgeReadyTarget(resolved, content));
}

export async function runPreToolUse(opts: { vault: string }): Promise<void> {
  const read = await readStdinTimeout();
  const result = await translatePreToolUse(read.text, path.resolve(opts.vault), read);
  if (result.warning !== null) process.stderr.write(`${result.warning}\n`);
  process.stdout.write(`${JSON.stringify(result.response)}\n`);
}
