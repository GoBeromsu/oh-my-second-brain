import { HARNESS_HIDDEN_CLI_COMMANDS, harnessSurfaceRegistry } from "../kernel/harness/surface-registry.js";
import type { HarnessSurfaceRegistry } from "../kernel/harness/surface-registry.js";

interface MainUsageCommand {
  readonly name: string;
  readonly line: string;
  readonly detailLines?: readonly string[];
}

const MAIN_USAGE_COMMANDS: readonly MainUsageCommand[] = [
  {
    name: "search",
    line: "  search    Search notes, read one note (--path), gather context, or suggest links.",
  },
  {
    name: "interview",
    line: "  interview Ask the vault owner about the vault in a terminal and seal the contract.",
  },
  {
    name: "write",
    line: "  write     Save a note from stdin only when the sealed contract allows it.",
  },
  {
    name: "setup",
    line: "  setup     Seal the vault contract; configure hosts, models, the package and bridges.",
    detailLines: [
      "              Writes only .oms/settings.json inside the vault.",
      "              Leaves: extract, status, host, model, package, bridge.",
    ],
  },
  {
    name: "doctor",
    line: "  doctor    Diagnose and repair: status, contract, audit, link-check, sync-embeddings,",
    detailLines: ["              cleanup, build-graph. `doctor status` is read-only."],
  },
  { name: "serve", line: "  serve     Start the MCP stdio server or local HTTP runtime." },
  { name: "hook", line: "  hook      Run the Claude Code vault guard hook." },
];

export function mainUsageCommandNames(
  registry: HarnessSurfaceRegistry = harnessSurfaceRegistry,
): readonly string[] {
  const registered = new Set(registry.cliCommands.map((command) => command.name));
  return MAIN_USAGE_COMMANDS.filter((command) => registered.has(command.name)).map((command) => command.name);
}

function commandLines(registry: HarnessSurfaceRegistry): string {
  const registered = new Set(registry.cliCommands.map((command) => command.name));
  const hidden = new Set(HARNESS_HIDDEN_CLI_COMMANDS);
  const lines: string[] = [];
  for (const command of MAIN_USAGE_COMMANDS) {
    if (!registered.has(command.name) || hidden.has(command.name)) continue;
    lines.push(command.line);
    if (command.detailLines !== undefined) lines.push(...command.detailLines);
  }
  return lines.join("\n");
}

export function cliUsageText(registry: HarnessSurfaceRegistry = harnessSurfaceRegistry): string {
  return `
oh-my-second-brain — Oh My Second Brain convention layer for Obsidian vaults

Usage:
  oh-my-second-brain search <text> [--mode <mode>] [options]
  oh-my-second-brain search --path <note> | --context [options] | --link <note> [options]
  oh-my-second-brain interview [--reask] [--vault <path>]
  oh-my-second-brain write <path> [--template <template>] [--vault <path>] < note.md
  oh-my-second-brain setup [extract|status|host|model|package|bridge] [options]
  oh-my-second-brain doctor <status|contract|audit|link-check|sync-embeddings|cleanup|build-graph> [options]
  oh-my-second-brain serve <mcp|http> [options]
  oh-my-second-brain --version | -v

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
