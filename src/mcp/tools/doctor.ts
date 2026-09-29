import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { auditVault } from "../../kernel/contract/audit.js";
import { gapsReport } from "../../kernel/contract/gaps-report.js";
import { contractDoctor } from "../../kernel/contract/status.js";
import { repairDoctor } from "../../kernel/doctor/service.js";
import type { McpEngineAdapter } from "../../kernel/engine/mcp/facade.js";
import { errorText, jsonText, stringArg, type ToolContext } from "./shared.js";

/** MCP `doctor`: diagnose or repair. Returns undefined for an operation it does not own. */
export async function handleDoctor(ctx: ToolContext, name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult | undefined> {
  const { vault, source, engine } = ctx;
  if (name === "oms_graph_build" || name === "oms_semantic_cleanup" || name === "oms_sync_embeddings") {
    const mode = name === "oms_sync_embeddings" ? stringArg(args, "mode") : undefined;
    if (name === "oms_sync_embeddings" && mode === "repair") {
      const repair = await repairDoctor({
        operation: "repair-index",
        vault,
        source,
        args: { repairMode: args?.["repairMode"], ...(args?.["dryRun"] === undefined ? {} : { dryRun: args["dryRun"] }) },
      });
      return repair.kind === "error" ? errorText(repair.message) : jsonText(repair.value);
    }
    const operation = name === "oms_graph_build" ? "build-graph" : name === "oms_semantic_cleanup" ? "semantic-cleanup" : "sync-embeddings";
    if (name === "oms_sync_embeddings") {
      args = {
        ...args,
        ...(mode === "sync" ? { update: true, embed: false } : { update: true, embed: true }),
      };
      delete args["mode"];
    }
    // A FACTORY, not a value. JavaScript evaluates an argument expression
    // before entering the callee, so passing a constructed adapter here would
    // open - and therefore create - `<vault>/.oms/engine-store.sqlite` before
    // repairDoctor got the chance to run admission. On an invalid global
    // target that means mutating a directory we are about to reject, which
    // breaks the verified-target contract's requirement that admission
    // precede ANY disk mutation. The kernel calls this only after admitting.
    //
    // Deliberately NOT re-checking admission here: two policy paths is how
    // the check drifts. One authoritative decision, deferred dependency.
    const resolveRepairAdapter = (): McpEngineAdapter =>
      operation === "build-graph"
        ? engine.adapter
        : operation === "semantic-cleanup" || (operation === "sync-embeddings" && args?.["embed"] === false)
            ? ctx.resolveCreatingDocumentAdapter()
            : ctx.getSemanticEngine().adapter;

    const repair = await repairDoctor({
      operation,
      vault,
      source,
      args,
      resolveAdapter: resolveRepairAdapter,
    });
    return repair.kind === "error" ? errorText(repair.message) : jsonText(repair.value);
  }

  if (name === "oms_contract_lineage_recover" || name === "oms_contract_lineage_reanchor") {
    const repair = await repairDoctor({ operation: name === "oms_contract_lineage_recover" ? "lineage-recover" : "lineage-reanchor", vault, source, args });
    return repair.kind === "error" ? errorText(repair.message) : jsonText(repair.value);
  }

  if (name === "oms_vault_audit") {
    if (
      args !== undefined &&
      Object.prototype.hasOwnProperty.call(args, "folder") &&
      typeof args["folder"] !== "string"
    ) {
      return errorText('Argument "folder" must be a string top-level folder name.');
    }
    const folder = stringArg(args, "folder");
    try {
      return jsonText({ vault, folder: folder ?? null, ...await auditVault(vault, folder === undefined ? {} : { folder }) });
    } catch {
      const doctor = await contractDoctor(vault, "agent");
      return jsonText({ vault, folder: folder ?? null, contract: doctor.contract, scannedNotes: 0, clean: false, violations: [], findings: doctor.findings });
    }
  }

  if (name === "oms_contract_gaps") {
    return jsonText({ vault, ...await gapsReport(vault) });
  }

  if (name === "oms_validate_templates") {
    return jsonText({ vault, ...await contractDoctor(vault, "agent") });
  }
  return undefined;
}
