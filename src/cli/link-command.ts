import {
  createVaultLink,
  LINKED_GITIGNORE_PATTERN,
  type CreateVaultLinkResult,
} from "../link/link.js";

export function formatLinkResult(result: CreateVaultLinkResult): string {
  const lines: string[] = ["Oh My Second Brain vault bridge ready."];
  lines.push(`  Vault:     ${result.record.vault}`);
  lines.push(`  Scope:     ${result.record.scope.join(", ") || "(none)"}`);
  if (result.linked.length > 0) lines.push(`  Linked:    ${result.linked.join(", ")}`);
  if (result.unchanged.length > 0) lines.push(`  Unchanged: ${result.unchanged.join(", ")}`);
  lines.push(`  Record:    ${result.recordPath}`);
  lines.push(
    result.gitignoreUpdated
      ? `  Gitignore: added ${LINKED_GITIGNORE_PATTERN}`
      : `  Gitignore: ${LINKED_GITIGNORE_PATTERN} already present`,
  );
  return lines.join("\n");
}

export async function runLink(options: {
  readonly cwd: string;
  readonly vault: string;
  readonly vaultExplicit: boolean;
  readonly folders: readonly string[];
}): Promise<number> {
  if (!options.vaultExplicit) {
    console.error("[oms] link requires --vault <path> (the Obsidian vault to bridge to).");
    return 1;
  }
  if (options.folders.length === 0) {
    console.error("[oms] link requires at least one --folder <name>.");
    return 1;
  }

  try {
    const result = await createVaultLink({
      cwd: options.cwd,
      vault: options.vault,
      folders: [...options.folders],
    });
    console.log(formatLinkResult(result));
    return 0;
  } catch (error) {
    console.error(`[oms] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
