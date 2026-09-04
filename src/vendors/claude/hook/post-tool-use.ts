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
 * Evaluates a changed markdown note against the resolved template convention.
 * This function is intentionally read-only: repairs belong to doctor operations.
 */
export async function auditNote(vault: string, relPath: string): Promise<string[]> {
  try {
    const convention = await loadResolvedTemplates(vault);
    const normalizedPath = relPath.replaceAll("\\", "/");
    const managedSource = Object.values(convention.templates).find(template =>
      template.destinationClass === "managed-default" && template.sourcePath === normalizedPath,
    );
    if (managedSource !== undefined) {
      return guidance([
        `${normalizedPath} is a managed template source; run oms_doctor validate, then regenerate-types through its approved operation.`,
      ]);
    }

    const raw = await readFile(safeVaultNotePath(vault, normalizedPath), "utf8");
    const { frontmatter } = parseNote(raw);
    const templateId = frontmatter["template"];
    if (typeof templateId !== "string" || templateId.trim() === "") {
      if (Object.hasOwn(frontmatter, "concept")) {
        return guidance([`${normalizedPath} has legacy concept-only frontmatter; add a stable template ID through oms_doctor backfill-defaults.`]);
      }
      return guidance([`${normalizedPath} is missing a stable template ID; add frontmatter template: <id>.`]);
    }

    const template = convention.templates[templateId];
    if (template === undefined) {
      return guidance([`${normalizedPath} references unknown template "${templateId}"; use a stable ID from the resolved template convention.`]);
    }

    const result = evaluateResolvedTemplateContract(frontmatter as Record<string, JsonValue>, template, convention.base, convention.writers);
    if (result.valid) return [];
    return guidance([
      `${normalizedPath} violates template "${templateId}": ${result.violations.map(violation => `${violation.field} (${violation.rule})`).join(", ")}.`,
    ]);
  } catch (error) {
    return guidance([
      `Cannot read the resolved template projection for ${relPath}: ${diagnostic(error)}. Run oms_doctor validate, then regenerate-types through its approved operation.`,
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
