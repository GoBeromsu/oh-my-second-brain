import { scanTemplateSources } from "./scan.js";
import type { TemplateContract, VaultContract } from "./types.js";

/** Compares a template source with the hash recorded at seal time. Read-only. */

export type DriftState = "active" | "drift" | "missing";

export async function templateDrift(vault: string, template: Pick<TemplateContract, "source" | "sourceHash">): Promise<DriftState> {
  let inventory;
  try {
    inventory = await scanTemplateSources(vault, [{ path: template.source, kind: "file" }]);
  } catch {
    return "drift";
  }
  const source = inventory.sources[0];
  const diagnostics = [...inventory.diagnostics, ...(source?.diagnostics ?? [])];
  if (diagnostics.some(item => item.code === "TEMPLATE_SOURCE_MISSING")) return "missing";
  if (!inventory.complete || diagnostics.length > 0) return "drift";
  if (source === undefined) return "missing";
  return source.rawDigest === template.sourceHash ? "active" : "drift";
}

/** Drift per template name. */
export async function detectDrift(vault: string, contract: VaultContract): Promise<Map<string, DriftState>> {
  const states = new Map<string, DriftState>();
  for (const [name, template] of Object.entries(contract.templates)) states.set(name, await templateDrift(vault, template));
  return states;
}
