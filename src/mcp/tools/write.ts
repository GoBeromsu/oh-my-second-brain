import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatDenyReason, type Violation } from "../../kernel/contract/types.js";
import type { WriteTargetSource } from "../../kernel/conventions/write-protocol.js";
import { verifiedWriteNote } from "../../kernel/write/verified-write.js";
import { jsonText } from "./shared.js";

const WRITE_KEYS: readonly string[] = ["path", "content", "template"];

function writeDenied(violations: readonly Violation[]): CallToolResult {
  const list = violations.map(violation => ({ field: violation.field, kind: violation.kind }));
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, violations: list, reason: formatDenyReason(list) }, null, 2) }] };
}

/**
 * MCP `write`: the judge decides and the kernel saves. Legacy and unknown keys are
 * refused rather than ignored; a denied write leaves the target byte-for-byte unchanged.
 */
export async function writeNote(vault: string, source: WriteTargetSource, args: Record<string, unknown>): Promise<CallToolResult> {
  const extra = Object.keys(args).filter(key => !WRITE_KEYS.includes(key)).sort();
  if (extra.length > 0) return writeDenied(extra.map(field => ({ field, kind: "unsupported-input" })));
  const missing = ["path", "content"].filter(key => typeof args[key] !== "string" || (key === "path" && args[key] === ""));
  if (missing.length > 0) return writeDenied(missing.map(field => ({ field, kind: "missing" })));
  if (args["template"] !== undefined && typeof args["template"] !== "string") return writeDenied([{ field: "template", kind: "unsupported-input" }]);
  const result = await verifiedWriteNote({
    vault,
    source,
    path: args["path"] as string,
    content: args["content"] as string,
    template: args["template"] as string | undefined,
  });
  switch (result.kind) {
    case "rejected":
      return jsonText({ ok: false, status: "rejected", rejection: result.rejection });
    case "denied":
      return writeDenied(result.violations);
    case "retry":
      return writeRetry(result.state);
    case "written":
      return jsonText({ ok: true, path: result.path, missingDefaults: result.missingDefaults.map(field => ({ field })) });
  }
}

/** The target moved under the judge; nothing was written and the same call can be retried. */
function writeRetry(state: "changed" | "vanished"): CallToolResult {
  const code = state === "changed" ? "WRITE_TARGET_CHANGED" : "WRITE_TARGET_VANISHED";
  const reason = state === "changed"
    ? "The note changed after it was judged; nothing was written. Read it again and retry."
    : "The note was removed after it was judged; nothing was written. Retry the write.";
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, code, retryable: true, reason }, null, 2) }] };
}
