import type { RoutingDecision } from "../routing/resolver.js";
import { writeProposal } from "../proposals/writer.js";

export type VaultOperationKind =
  | "note-create"
  | "note-move"
  | "note-rename"
  | "note-route"
  | "config-write"
  | "rules-write"
  | "docs-write"
  | "compile-output-write"
  | "plugin-data-write";

export type VaultOperationMode =
  | "obsidian-native"
  | "proposal-only"
  | "filesystem";

export interface UserVisibleVaultOperationPlan {
  mode: "obsidian-native" | "proposal-only";
  destination?: string;
  proposalPath?: string;
  reason?: "native-unavailable" | "ambiguous" | "missing-target" | "missing-config";
}

const USER_VISIBLE_MUTATIONS = new Set<VaultOperationKind>([
  "note-create",
  "note-move",
  "note-rename",
  "note-route",
]);

export function resolveVaultOperationMode(
  kind: VaultOperationKind,
  nativeAvailable: boolean,
): VaultOperationMode {
  if (USER_VISIBLE_MUTATIONS.has(kind)) {
    return nativeAvailable ? "obsidian-native" : "proposal-only";
  }

  return "filesystem";
}

function buildNativeUnavailableProposal(
  kind: VaultOperationKind,
  noteKind: string,
  destination: string,
): string {
  return [
    `# Vault Operation Proposal: ${noteKind}`,
    "",
    `Operation: ${kind}`,
    "Reason: native-unavailable",
    `Intended destination: ${destination}`,
    "",
    "OMSB resolved a deterministic destination, but Obsidian-native support is unavailable.",
    "User confirmation is required before proceeding with a user-visible vault mutation.",
    "",
  ].join("\n");
}

export function planUserVisibleVaultOperation(
  vaultPath: string,
  slug: string,
  kind: Extract<VaultOperationKind, "note-create" | "note-move" | "note-rename" | "note-route">,
  noteKind: string,
  routing: RoutingDecision & { proposalPath?: string },
  nativeAvailable: boolean,
): UserVisibleVaultOperationPlan {
  if (routing.kind === "propose") {
    return {
      mode: "proposal-only",
      proposalPath: routing.proposalPath,
      reason: routing.reason,
    };
  }

  const mode = resolveVaultOperationMode(kind, nativeAvailable);
  if (mode === "obsidian-native") {
    return {
      mode,
      destination: routing.destination,
    };
  }

  const proposalPath = writeProposal(
    vaultPath,
    `${slug}-${noteKind}-${kind}`,
    buildNativeUnavailableProposal(kind, noteKind, routing.destination),
  );

  return {
    mode: "proposal-only",
    destination: routing.destination,
    proposalPath,
    reason: "native-unavailable",
  };
}
