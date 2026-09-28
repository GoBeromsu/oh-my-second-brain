import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { WriteTargetSource } from "../../kernel/conventions/write-protocol.js";
import { deniedWritePayload, writePayload, type WritePayload } from "../../kernel/write/payload.js";
import { runWritePipeline } from "../../kernel/write/pipeline.js";

const WRITE_KEYS: readonly string[] = ["path", "content", "template", "ifMatch", "check"];

function toolResult(payload: WritePayload): CallToolResult {
  const text = JSON.stringify(payload, null, 2);
  // A rejected target and a check verdict are reported as data (not isError); every other refusal is an error.
  if (payload.ok || "status" in payload) return { content: [{ type: "text", text }] };
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * MCP `write`: the write pipeline conforms, the judge decides and the kernel saves.
 * Legacy and unknown keys are refused rather than ignored; a denied write leaves the
 * target byte-for-byte unchanged, and an overwrite must carry the note's `ifMatch`.
 */
export async function writeNote(vault: string, source: WriteTargetSource, args: Record<string, unknown>): Promise<CallToolResult> {
  const extra = Object.keys(args).filter(key => !WRITE_KEYS.includes(key)).sort();
  if (extra.length > 0) return toolResult(deniedWritePayload(extra.map(field => ({ field, kind: "unsupported-input" }))));
  const missing = ["path", "content"].filter(key => typeof args[key] !== "string" || (key === "path" && args[key] === ""));
  if (missing.length > 0) return toolResult(deniedWritePayload(missing.map(field => ({ field, kind: "missing" }))));
  const mistyped = [
    ...(["template", "ifMatch"] as const).filter(key => args[key] !== undefined && typeof args[key] !== "string"),
    ...(args["check"] !== undefined && typeof args["check"] !== "boolean" ? ["check"] : []),
  ];
  if (mistyped.length > 0) return toolResult(deniedWritePayload(mistyped.map(field => ({ field, kind: "unsupported-input" }))));
  const outcome = await runWritePipeline({
    vault,
    source,
    path: args["path"] as string,
    content: args["content"] as string,
    template: args["template"] as string | undefined,
    ifMatch: args["ifMatch"] as string | undefined,
    check: args["check"] as boolean | undefined,
  });
  return toolResult(writePayload(outcome));
}
