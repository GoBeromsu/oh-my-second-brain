import type { OmsbConfig } from "../rules/types.js";
import {
  resolveDestinationWithProposal,
  type RoutingDecision,
} from "../routing/resolver.js";
import {
  planUserVisibleVaultOperation,
  type UserVisibleVaultOperationPlan,
} from "../obsidian/operations.js";

export interface TerminologyPlacementPlan {
  routing: RoutingDecision & { proposalPath?: string };
  operation: UserVisibleVaultOperationPlan;
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

  const operation = planUserVisibleVaultOperation(
    vaultPath,
    slug,
    "note-route",
    "terminology",
    routing,
    nativeAvailable,
  );

  return {
    routing,
    operation,
  };
}
