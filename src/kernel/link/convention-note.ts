import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const CONVENTION_NOTE_BEGIN = "<!-- oms:begin -->";
export const CONVENTION_NOTE_END = "<!-- oms:end -->";

export interface ConventionUsageSectionResult {
  readonly agentsPath: string;
  readonly changed: boolean;
  readonly created: boolean;
  readonly replaced: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderVaultName(vaultPath: string): string {
  const name = path.basename(path.resolve(vaultPath)) || "linked vault";
  return name.replace(/\r?\n/g, " ").replaceAll(CONVENTION_NOTE_BEGIN, "[oms begin marker]").replaceAll(CONVENTION_NOTE_END, "[oms end marker]");
}

export function conventionUsageSection(vaultPath: string): string {
  const renderedVaultName = renderVaultName(vaultPath);
  return [
    CONVENTION_NOTE_BEGIN,
    "## Oh My Second Brain (OMS)",
    "",
    "This repository is linked to an Oh My Second Brain vault. Use the linked vault as the project knowledge base when you need durable context.",
    "",
    `- Connected vault: ${renderedVaultName} (connection details live in .oms/links.yaml)`,
    "- Query context: `oms search query \"what context should I know for this change?\"`",
    "- Search notes: `oms search query \"keyword or topic\"`",
    "- Open a note: `oms note get \"note-id-or-path\"`",
    "- MCP integration: run `oms serve mcp` from this repository so compatible agents can read the linked vault through MCP.",
    CONVENTION_NOTE_END,
  ].join("\n");
}

export async function writeConventionUsageSection(
  repoRoot: string,
  vaultPath: string,
): Promise<ConventionUsageSectionResult> {
  const agentsPath = path.join(repoRoot, "AGENTS.md");
  let existing = "";
  let created = false;

  try {
    existing = await readFile(agentsPath, "utf-8");
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    created = true;
  }

  const block = conventionUsageSection(vaultPath);
  const managedBlockPattern = new RegExp(
    `${escapeRegExp(CONVENTION_NOTE_BEGIN)}[\\s\\S]*?${escapeRegExp(CONVENTION_NOTE_END)}`,
    "g",
  );
  const matches = Array.from(existing.matchAll(managedBlockPattern));
  const replaced = matches.length > 0;
  let replacedFirst = false;
  const next = replaced
    ? existing.replace(managedBlockPattern, () => {
        if (!replacedFirst) {
          replacedFirst = true;
          return block;
        }
        return "";
      })
    : `${existing}${existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n"}${block}\n`;

  if (next !== existing) {
    await writeFile(agentsPath, next, "utf-8");
  }

  return { agentsPath, changed: next !== existing, created, replaced };
}
