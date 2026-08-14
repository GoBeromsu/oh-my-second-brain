import {
  createVaultLink,
  LINKED_GITIGNORE_PATTERN,
  type CreateVaultLinkResult,
} from "../link/link.js";
import { writeConventionUsageSection } from "../link/convention-note.js";

export function formatLinkResult(
  result: CreateVaultLinkResult,
  conventionNotePath?: string,
): string {
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
  if (conventionNotePath !== undefined) {
    lines.push(`  Convention: wrote ${conventionNotePath}`);
  }
  return lines.join("\n");
}

export async function runLink(options: {
  readonly cwd: string;
  readonly vault: string;
  readonly vaultExplicit: boolean;
  readonly folders: readonly string[];
  readonly conventionNote?: boolean;
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
    let conventionNotePath: string | undefined;
    if (options.conventionNote !== false) {
      conventionNotePath = (await writeConventionUsageSection(options.cwd, result.record.vault)).agentsPath;
    }
    console.log(formatLinkResult(result, conventionNotePath));
    return 0;
  } catch (error) {
    console.error(`[oms] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
