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
    line: "  setup    Adopt an existing vault into the Oh My Second Brain convention.",
    detailLines: [
      "             First run `setup --dry-run` to show an approval digest.",
      "             Apply only with `setup --yes --approval-token <shown-token> --approved-digest <shown-digest>`.",
      "             Setup publishes no contract; the contract is published by `oms template publish`.",
      "             --models-default          Install the pinned local model (EmbeddingGemma-300M, 768d).",
      "             --models-descriptor <path> Install an operator-supplied model descriptor instead.",
      "             --models-no-default       Waive model installation; vector search stays unavailable.",
    ],
  },
  {
    name: "template",
    line: "  template Review, publish, and inspect the user-owned contract.",
    detailLines: [
      "             list | show | scan | check | publish | review-sources | acknowledge-source | relink-source",
      "             Contract meaning is the explicit policy document you publish; it is never",
      "             derived from a file name or from template syntax.",
      "             Run `oms template --help` for leaf arguments and confirmation requirements.",
    ],
  },
  { name: "note", line: "  note     Guide, check, audit, or get notes. The agent writes the note." },
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
    line: "  hook     Run Claude Code pre/post vault guard hooks.",
    detailLines: [
      "             pre  Read PreToolUse JSON from stdin; block unregistered folder creation.",
      "             post Read PostToolUse JSON from stdin; audit affected frontmatter.",
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
  oh-my-second-brain setup [--vault <path>] [--dry-run | --yes --approval-token <token> --approved-digest <sha256:...>]
  oh-my-second-brain template <list|show|scan|check|publish|review-sources|acknowledge-source|relink-source> [options]
  oh-my-second-brain note <guide|check|audit|get> [options]
  oh-my-second-brain link <suggest|check> [options]
  oh-my-second-brain bridge <add|remove|status> [options]
  oh-my-second-brain search <query|context> [options]
  oh-my-second-brain index <sync|embed|repair|status|clean> [options]
  oh-my-second-brain graph <build|status> [options]
  oh-my-second-brain host <install|remove|sync|status> [options]
  oh-my-second-brain package <check|update> [options]
  oh-my-second-brain model <install|select|waive|status> [options]
  oh-my-second-brain serve <mcp|http> [options]
  oh-my-second-brain hook <pre|post> [--vault <path>]
  oh-my-second-brain status [options]

Compatibility alias: oms <command>

Commands:
${commandLines(registry)}

Options:
  --vault <path>   Vault root. When omitted, resolution is local vault controls, then a\n                   bridge link, then OMS_VAULT, and only then the current directory as a\n                   read-only fallback that cannot admit a mutation.
  --yes            setup: apply only with the --approval-token and --approved-digest an earlier dry-run printed.
  --approval-token <token>
                  setup: exact approval token shown by \`setup --dry-run\`; required with --yes.
  --approved-digest <sha256:...>
                  setup: exact digest shown by \`setup --dry-run\`; required with --yes and never generated by --yes.
  --install-claude Print Claude Code plugin install and MCP registration commands (dry-run).
  --dry-run        setup: print the proposal and approval digest without writing.
  --models-default
                  setup: download and verify the pinned EmbeddingGemma-300M model into the
                  user-level cache, then select it for \`oms index embed\` and vector search without
                  requiring OMS_EMBEDDING_PROVIDER / OMS_EMBEDDING_MODEL.
  --models-descriptor <path>
                  setup: install an operator-supplied model descriptor (SHA-256 verified).
  --models-no-default
                  setup: explicitly install no model; lexical search still works.
`;
}

export function printUsage(): void {
  console.log(cliUsageText());
}
