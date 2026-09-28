import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { WriteTargetSource } from "../../kernel/conventions/write-protocol.js";
import {
  deniedWritePayload,
  verifiedWriteNote,
  verifiedWritePayload,
  type VerifiedWritePayload,
} from "../../kernel/write/verified-write.js";

const WRITE_KEYS: readonly string[] = ["path", "content", "template"];

function toolResult(payload: VerifiedWritePayload): CallToolResult {
  const text = JSON.stringify(payload, null, 2);
  // A rejected target is reported as data (not isError), as before; every other refusal is an error.
  if (payload.ok || "status" in payload) return { content: [{ type: "text", text }] };
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * MCP `write`: the judge decides and the kernel saves. Legacy and unknown keys are
 * refused rather than ignored; a denied write leaves the target byte-for-byte unchanged.
 */
export async function writeNote(vault: string, source: WriteTargetSource, args: Record<string, unknown>): Promise<CallToolResult> {
  const extra = Object.keys(args).filter(key => !WRITE_KEYS.includes(key)).sort();
  if (extra.length > 0) return toolResult(deniedWritePayload(extra.map(field => ({ field, kind: "unsupported-input" }))));
  const missing = ["path", "content"].filter(key => typeof args[key] !== "string" || (key === "path" && args[key] === ""));
  if (missing.length > 0) return toolResult(deniedWritePayload(missing.map(field => ({ field, kind: "missing" }))));
  if (args["template"] !== undefined && typeof args["template"] !== "string") {
    return toolResult(deniedWritePayload([{ field: "template", kind: "unsupported-input" }]));
  }
  const result = await verifiedWriteNote({
    vault,
    source,
    path: args["path"] as string,
    content: args["content"] as string,
    template: args["template"] as string | undefined,
  });
  return toolResult(verifiedWritePayload(result));
}
