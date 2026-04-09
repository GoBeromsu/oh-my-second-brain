import type { RoutingConfig } from "../rules/types.js";
import { writeProposal } from "../proposals/writer.js";

export type RoutingDecision =
  | {
      kind: "explicit";
      destination: string;
    }
  | {
      kind: "inbox";
      destination: string;
    }
  | {
      kind: "propose";
      candidates: string[];
      reason: "ambiguous" | "missing-target" | "missing-config";
    };

export function resolveDestination(
  noteKind: string,
  routing?: RoutingConfig,
): RoutingDecision {
  if (routing === undefined) {
    return {
      kind: "propose",
      candidates: [],
      reason: "missing-config",
    };
  }

  const targets = routing.note_targets?.[noteKind] ?? [];
  if (targets.length === 1) {
    return {
      kind: "explicit",
      destination: targets[0],
    };
  }

  if (targets.length > 1) {
    return {
      kind: "propose",
      candidates: [...targets],
      reason: "ambiguous",
    };
  }

  if (routing.inbox_fallback !== undefined && routing.inbox_fallback.length > 0) {
    return {
      kind: "inbox",
      destination: routing.inbox_fallback,
    };
  }

  return {
    kind: "propose",
    candidates: [],
    reason: "missing-target",
  };
}

export function resolveDestinationWithProposal(
  vaultPath: string,
  slug: string,
  noteKind: string,
  routing?: RoutingConfig,
): RoutingDecision & { proposalPath?: string } {
  const decision = resolveDestination(noteKind, routing);
  if (decision.kind !== "propose") {
    return decision;
  }

  const proposalPath = writeProposal(
    vaultPath,
    slug,
    [
      `# Routing Proposal: ${noteKind}`,
      "",
      `Reason: ${decision.reason}`,
      decision.candidates.length > 0
        ? `Candidates: ${decision.candidates.join(", ")}`
        : "Candidates: none",
      "",
      "User confirmation is required before mutating the vault.",
      "",
    ].join("\n"),
  );

  return {
    ...decision,
    proposalPath,
  };
}
