import { acquireEmbeddingModel, type EmbeddingModelDescriptor } from "../kernel/engine/embed/model.js";
import { applySetup, composeSetup, decideNonInteractiveSetup, inspectSetup } from "../kernel/setup/service.js";
import type { Digest } from "../kernel/templates/types.js";
import { buildClaudeInstallPlan, printClaudeInstallPlan } from "./claude-install-plan.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface SetupPrompt { question(query: string): Promise<string>; close(): void; }
export type SetupEmbeddingDescriptor = EmbeddingModelDescriptor & { readonly url: string; readonly sha256: string; };

export async function runSetup(opts: {
  vault: string;
  yes: boolean;
  installClaude?: boolean;
  dryRun?: boolean;
  approvedDigest?: Digest;
  templateFolder?: string;
  prompt?: SetupPrompt;
  embeddingDescriptor?: SetupEmbeddingDescriptor | null;
  embeddingCacheDir?: string;
  embeddingNoDefault?: boolean;
  embeddingFetchImpl?: typeof fetch;
}): Promise<void> {
  const { vault, yes, installClaude = false, dryRun = false, approvedDigest, templateFolder, embeddingDescriptor, embeddingCacheDir, embeddingNoDefault, embeddingFetchImpl } = opts;
  if (!yes && !dryRun) throw new Error("Setup apply requires --yes and an approved dry-run digest.");
  if (!dryRun && (approvedDigest === undefined || !DIGEST.test(approvedDigest))) throw new Error("Setup apply requires approvedDigest from a shown dry-run proposal.");
  if (embeddingDescriptor !== undefined && embeddingDescriptor !== null && embeddingNoDefault === true) throw new Error("Setup embeddingDescriptor and embeddingNoDefault are mutually exclusive.");
  const state = await inspectSetup({ vault, templateFolder });
  const decision = await decideNonInteractiveSetup(state);
  const manifest = await composeSetup(decision, { base: { fields: {} } });
  if (dryRun) {
    const receipt = await applySetup(decision, manifest, { dryRun: true });
    console.log(JSON.stringify({ inputDigest: manifest.proposed.inputDigest, approvalDigest: manifest.approvalDigest, outputDigest: manifest.outputDigest, receipt }, null, 2));
    return;
  }
  if (approvedDigest === undefined) throw new Error("Setup apply requires approvedDigest from a shown dry-run proposal.");
  const receipt = await applySetup(decision, manifest, { approvedDigest });
  if (receipt.status === "rejected" || receipt.status === "inconsistent") throw new Error(receipt.diagnostics.map(item => item.code).join(","));
  if (embeddingDescriptor !== undefined && embeddingDescriptor !== null) {
    await acquireEmbeddingModel({ vault, cacheDir: embeddingCacheDir, descriptor: embeddingDescriptor, fetchImpl: embeddingFetchImpl });
  }
  console.log(`Oh My Second Brain setup complete. Approval: ${manifest.approvalDigest}`);
  if (embeddingNoDefault === true || embeddingDescriptor === null) console.log("Embedding model: no default (explicit waiver)");
  if (installClaude) { printClaudeInstallPlan(buildClaudeInstallPlan({ vault })); }
}
