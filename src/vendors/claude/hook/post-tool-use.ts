import { readFile } from "node:fs/promises";
import path from "node:path";
import { safeVaultNotePath } from "../../../kernel/capture/safe.js";
import { parseNote } from "../../../kernel/conventions/frontmatter.js";
import { evaluateResolvedTemplateContract } from "../../../kernel/conventions/write-contract.js";
import { loadResolvedTemplates } from "../../../kernel/templates/resolver.js";
import type { JsonValue } from "../../../kernel/templates/types.js";
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
 * The hook never blocks or repairs a save: it reports what the approved
 * contract says about the bytes on disk. An unbound note is checked against the
 * always-on default layer, which is the correct contract for it.
 */
export async function auditNote(vault: string, relPath: string): Promise<string[]> {
  try {
    const snapshot = await loadResolvedTemplates(vault);
    const normalizedPath = relPath.replaceAll("\\", "/");
    const managedSource = snapshot.sources.find(freshness => freshness.source.path === normalizedPath);
    if (managedSource !== undefined) {
      return guidance([
        `${normalizedPath} is a raw template source; review it with oms template review before publishing a contract change.`,
      ]);
    }

    const raw = await readFile(safeVaultNotePath(vault, normalizedPath), "utf8");
    const { frontmatter, body } = parseNote(raw);
    const identity = frontmatter["template"];
    if (identity !== undefined && typeof identity !== "string") {
      return guidance([`${normalizedPath} declares a non-string template identity; use template: <id> or omit it.`]);
    }
    const templateId = typeof identity === "string" && identity.trim() !== "" ? identity : null;
    if (templateId !== null && snapshot.templates[templateId] === undefined) {
      return guidance([`${normalizedPath} references unknown template "${templateId}"; use a registered template id or omit the field.`]);
    }
    const contract = templateId === null ? snapshot.defaultContract : snapshot.templates[templateId]!;

    const result = evaluateResolvedTemplateContract(frontmatter as Record<string, JsonValue>, contract, body);
    if (result.valid) return [];
    const label = templateId === null ? "the default contract" : `template "${templateId}"`;
    return guidance([
      `${normalizedPath} does not yet satisfy ${label}: ${result.violations.map(violation => `${violation.field} (${violation.rule})`).join(", ")}.`,
    ]);
  } catch (error) {
    return guidance([
      `Cannot read the approved contract for ${relPath}: ${diagnostic(error)}. Run oms template check, then publish the reviewed contract.`,
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
