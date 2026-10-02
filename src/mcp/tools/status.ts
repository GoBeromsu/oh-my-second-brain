import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { contractStatus } from "../../kernel/contract/status.js";
import type { WriteTargetSource } from "../../kernel/conventions/write-protocol.js";
import { evolutionStatus } from "../../kernel/doctor/evolution-status.js";
import { readSearchTemplateSource } from "../../kernel/engine/retrieval/template-source.js";
import { summarizeRuntimeHistory } from "../../kernel/runtime/event-summary.js";
import { jsonText, type ToolContext } from "./shared.js";
import type { MaintenanceStatus } from "../../kernel/engine/maintenance-controller.js";

export function runtimeHistory(vault: string): { readonly history?: ReturnType<typeof summarizeRuntimeHistory>; readonly runtimeWarnings?: readonly string[] } {
  try {
    return { history: summarizeRuntimeHistory({ vaultPath: vault }) };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message.replace(/^LEDGER_APPEND_FAILED:\s*/, "") : String(error);
    return { runtimeWarnings: [`LEDGER_APPEND_FAILED: ${detail}. Runtime history is unavailable; verify the external OMS runtime ledger.`] };
  }
}

function writePosture(source: WriteTargetSource, reason: "tampered" | "broken" | undefined): string {
  if (source === "cwd") return "write-disabled-target-unverified";
  if (reason === "tampered") return "write-disabled-contract-tampered";
  if (reason === "broken") return "write-unverified-contract";
  return "write-gated-by-verified-target-and-contract";
}

/** MCP `doctor op: status`: read-only health. `readTools` is the read-only tool list, passed in to avoid importing the server. */
export async function handleStatus(ctx: ToolContext, readTools: readonly string[], maintenance?: MaintenanceStatus & { readonly sqliteVersion: string }): Promise<CallToolResult> {
  const { vault, source, engine } = ctx;
  const engineGraph = await engine.adapter.graphStatus(vault).catch(() => null);
  // Posture follows the sealed contract the write surface judges against.
  // An open vault (no contract sealed) stays writable; a tampered seal
  // disables writes, and a broken one lets them through unjudged.
  const meta = await readSearchTemplateSource(vault);
  const contract = await contractStatus(vault);
  // Read-only: counters, requests awaiting the owner, autonomous budget, lineage gap.
  const evolution = await evolutionStatus(vault, Date.now()).catch(() => ({ unavailable: "evolution status could not be read; run `oms doctor contract`" }));
  return jsonText({
    vault,
    contract,
    evolution,
    counts: meta.source.templates === null
      ? null
      : { templates: Object.keys(meta.source.templates).length },
    generationDigest: meta.digest,
    diagnostics: meta.diagnostics,
    ...runtimeHistory(vault),
    engineGraph,
    writeTools: writePosture(source, contract.reason),
    readTools,
    ...(maintenance === undefined ? {} : { maintenance }),
  });
}
