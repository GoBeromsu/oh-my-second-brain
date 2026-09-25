import { harnessSurfaceRegistry } from "../kernel/harness/surface-registry.js";
import type { HarnessSurfaceRegistry } from "../kernel/harness/surface-registry.js";

interface MainUsageCommand {
  readonly name: string;
  readonly line: string;
  readonly detailLines?: readonly string[];
}

const MAIN_USAGE_COMMANDS: readonly MainUsageCommand[] = [
  {
    name: "setup",
    line: "  setup    Interview the vault and seal its contract (interactive; re-run to re-seal).",
    detailLines: [
      "             Writes only .oms/settings.json inside the vault; same as `oms contract setup`.",
      "             Models: `oms model install|select`. Host integrations: `oms host install`.",
    ],
  },
  { name: "contract", line: "  contract Set up, extract, inspect, and diagnose the sealed vault contract." },
  { name: "note", line: "  note     Audit or get notes. The agent writes the note." },
  { name: "link", line: "  link     Suggest or check vault wikilinks." },
  { name: "bridge", line: "  bridge   Add, remove, or inspect external-repository vault bridges." },
  { name: "search", line: "  search   Query notes or inspect search context." },
  { name: "index", line: "  index    Sync, embed, repair, inspect, or clean the vault index." },
  { name: "graph", line: "  graph    Build or inspect the vault graph." },
  { name: "host", line: "  host     Install, remove, sync, or inspect host integrations." },
  { name: "package", line: "  package  Check for or apply package updates." },
  { name: "model", line: "  model    Install, select, waive, or inspect embedding models." },
  { name: "serve", line: "  serve    Start the MCP stdio server or local HTTP runtime." },
  {
    name: "hook",
    line: "  hook     Run the Claude Code vault guard hook.",
    detailLines: [
      "             pre  Read PreToolUse JSON from stdin; ask the contract judge for a verdict.",
    ],
  },
  { name: "status", line: "  status   Show read-only vault health and statistics." },
];

export function mainUsageCommandNames(
  registry: HarnessSurfaceRegistry = harnessSurfaceRegistry,
): readonly string[] {
  const registered = new Set(registry.cliCommands.map((command) => command.name));
  return MAIN_USAGE_COMMANDS.filter((command) => registered.has(command.name)).map((command) => command.name);
}

function commandLines(registry: HarnessSurfaceRegistry): string {
  const registered = new Set(registry.cliCommands.map((command) => command.name));
  const lines: string[] = [];
  for (const command of MAIN_USAGE_COMMANDS) {
    if (!registered.has(command.name)) continue;
    lines.push(command.line);
    if (command.detailLines !== undefined) lines.push(...command.detailLines);
  }
  return lines.join("\n");
}

export function cliUsageText(registry: HarnessSurfaceRegistry = harnessSurfaceRegistry): string {
  return `
oh-my-second-brain — Oh My Second Brain convention layer for Obsidian vaults

Usage:
  oh-my-second-brain setup [--vault <path>]
  oh-my-second-brain contract <setup|extract|status|doctor> [options]
  oh-my-second-brain note <audit|get> [options]
  oh-my-second-brain link <suggest|check> [options]
  oh-my-second-brain bridge <add|remove|status> [options]
  oh-my-second-brain search <query|context> [options]
  oh-my-second-brain index <sync|embed|repair|status|clean> [options]
  oh-my-second-brain graph <build|status> [options]
  oh-my-second-brain host <install|remove|sync|status> [options]
  oh-my-second-brain package <check|update> [options]
  oh-my-second-brain model <install|select|waive|status> [options]
  oh-my-second-brain serve <mcp|http> [options]
  oh-my-second-brain hook pre [--vault <path>]
  oh-my-second-brain status [options]

Compatibility alias: oms <command>

Commands:
${commandLines(registry)}

Options:
  --vault <path>   Vault root. When omitted, resolution is local vault controls, then a\n                   bridge link, then OMS_VAULT, and only then the current directory as a\n                   read-only fallback that cannot admit a mutation.
`;
}

export function printUsage(): void {
  console.log(cliUsageText());
}
