import type { OmsbConfig } from "../rules/types.js";
import {
  resolveDestinationWithProposal,
  type RoutingDecision,
} from "../routing/resolver.js";
import {
  resolveVaultOperationMode,
  type VaultOperationMode,
} from "../obsidian/operations.js";

export interface TerminologyPlacementPlan {
  routing: RoutingDecision & { proposalPath?: string };
  operationMode: VaultOperationMode;
}

export function planTerminologyPlacement(
  vaultPath: string,
  slug: string,
  config: OmsbConfig,
  nativeAvailable: boolean,
): TerminologyPlacementPlan {
  const routing = resolveDestinationWithProposal(
    vaultPath,
    slug,
    "terminology",
    config.routing,
  );

  const operationMode =
    routing.kind === "propose"
      ? "proposal-only"
      : resolveVaultOperationMode("note-route", nativeAvailable);

  return {
    routing,
    operationMode,
  };
}
