import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { contractStatus } from "../../kernel/contract/status.js";
import { readSearchTemplateSource } from "../../kernel/engine/retrieval/template-source.js";
import { summarizeRuntimeHistory } from "../../kernel/runtime/event-summary.js";
import { jsonText, type ToolContext } from "./shared.js";

export function runtimeHistory(vault: string): { readonly history?: ReturnType<typeof summarizeRuntimeHistory>; readonly runtimeWarnings?: readonly string[] } {
  try {
    return { history: summarizeRuntimeHistory({ vaultPath: vault }) };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message.replace(/^LEDGER_APPEND_FAILED:\s*/, "") : String(error);
    return { runtimeWarnings: [`LEDGER_APPEND_FAILED: ${detail}. Runtime history is unavailable; verify the external OMS runtime ledger.`] };
  }
}

/** MCP `status`: read-only health. `readTools` is the read-only tool list, passed in to avoid importing the server. */
export async function handleStatus(ctx: ToolContext, op: string | undefined, readTools: readonly string[]): Promise<CallToolResult> {
  const { vault, source, engine } = ctx;
  if (op === "graph") {
    return jsonText(await engine.adapter.graphStatus(vault));
  }
  const engineGraph = await engine.adapter.graphStatus(vault).catch(() => null);
  // Posture follows the sealed contract the write surface judges against.
  // An open vault (no contract sealed) stays writable; only an unreadable
  // seal disables writes.
  const meta = await readSearchTemplateSource(vault);
  const contract = await contractStatus(vault);
  return jsonText({
    vault,
    contract,
    counts: meta.source.templates === null
      ? null
      : { templates: Object.keys(meta.source.templates).length },
    generationDigest: meta.digest,
    diagnostics: meta.diagnostics,
    ...runtimeHistory(vault),
    engineGraph,
    writeTools: source === "cwd"
      ? "write-disabled-target-unverified"
      : contract.contract === "unreadable" ? "write-disabled-contract-unreadable" : "write-gated-by-verified-target-and-contract",
    readTools,
  });
}
