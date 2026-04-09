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
