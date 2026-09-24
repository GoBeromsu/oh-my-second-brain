import { readFile } from "node:fs/promises";
import path from "node:path";
import { safeVaultNotePath } from "../../../kernel/capture/safe.js";
import { parseNote } from "../../../kernel/conventions/frontmatter.js";
import { evaluateContractV5 } from "../../../kernel/templates/contract-check.js";
import { composeContractV5, parseContractPolicyV5 } from "../../../kernel/templates/contract-v5.js";
import { readStdinTimeout } from "./stdin.js";

interface PostToolUsePayload {
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function guidance(lines: readonly string[]): string[] {
  return lines.map(line => `[oms-template] ${line}`);
}

/**
 * Advisory check of a note the agent just saved.
 *
 * The hook never blocks or repairs a save: it reports what the published
 * contract says about the bytes on disk. A note with no registration is checked
 * against the always-on common contract, which is the correct contract for it.
 */
export async function auditNote(vault: string, relPath: string): Promise<string[]> {
  try {
    const policy = parseContractPolicyV5(await readFile(path.join(vault, ".oms", "template-policy.json"), "utf8"));
    const normalizedPath = relPath.replaceAll("\\", "/");
    const registered = Object.values(policy.templates)
      .some(entry => entry.status === "active" && entry.source.path === normalizedPath);
    if (registered) {
      return guidance([
        `${normalizedPath} is a registered template source; review it with oms template review-sources before changing the contract.`,
      ]);
    }

    const raw = await readFile(safeVaultNotePath(vault, normalizedPath), "utf8");
    const { frontmatter, body } = parseNote(raw);
    const identity = frontmatter["template"];
    if (identity !== undefined && typeof identity !== "string") {
      return guidance([`${normalizedPath} declares a non-string template identity; use template: <id> or omit it.`]);
    }
    const templateId = typeof identity === "string" && identity.trim() !== "" ? identity : null;
    if (templateId !== null && policy.templates[templateId] === undefined) {
      return guidance([`${normalizedPath} references unknown template "${templateId}"; use a registered template id or omit the field.`]);
    }
    const contract = composeContractV5(policy, templateId);

    const result = evaluateContractV5(frontmatter, body, contract);
    if (result.valid) return [];
    const label = templateId === null ? "the common contract" : `template "${templateId}"`;
    return guidance([
      `${normalizedPath} does not yet satisfy ${label}: ${result.violations.map(violation => `${violation.field} (${violation.rule})`).join(", ")}.`,
    ]);
  } catch (error) {
    return guidance([
      `Cannot read the published contract for ${relPath}: ${diagnostic(error)}. Run oms template check, then publish the reviewed contract.`,
    ]);
  }
}

export async function runPostToolUse(opts: { vault: string }): Promise<void> {
  const vault = path.resolve(opts.vault);

  let rawInput: string;
  try {
    rawInput = await readStdinTimeout();
  } catch {
    return;
  }

  let payload: PostToolUsePayload;
  try {
    payload = JSON.parse(rawInput) as PostToolUsePayload;
  } catch {
    return;
  }

  const toolName = (payload.tool_name ?? payload.toolName ?? "").toLowerCase();
  if (toolName !== "write" && toolName !== "edit") return;

  const toolInput = payload.tool_input ?? {};
  const rawFilePath = String(toolInput["path"] ?? toolInput["file_path"] ?? "");
  if (!rawFilePath) return;

  const absFilePath = path.isAbsolute(rawFilePath) ? rawFilePath : path.resolve(rawFilePath);
  const relPath = path.relative(vault, absFilePath).replace(/\\/g, "/");
  if (relPath.startsWith("..") || path.isAbsolute(relPath) || !relPath.endsWith(".md")) return;

  const lines = await auditNote(vault, relPath);
  if (lines.length === 0) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: lines.join("\n"),
    },
  }) + "\n");
}
