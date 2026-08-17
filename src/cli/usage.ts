import { harnessSurfaceRegistry } from "../harness/surface-registry.js";
import type { HarnessSurfaceRegistry } from "../harness/surface-registry.js";

interface MainUsageCommand {
  readonly name: string;
  readonly line: string;
  readonly detailLines?: readonly string[];
}

const MAIN_USAGE_COMMANDS: readonly MainUsageCommand[] = [
  { name: "setup", line: "  setup    Adopt an existing vault into the Oh My Second Brain convention." },
  { name: "install", line: "  install  Install Oh My Second Brain host adapters and MCP registration." },
  { name: "uninstall", line: "  uninstall Remove Oh My Second Brain host adapters and MCP registration." },
  { name: "update", line: "  update   Check for or apply an explicit package update, then refresh host adapters." },
  { name: "doctor", line: "  doctor   Validate vault frontmatter against the active ontology, aggregated by field and concept." },
  {
    name: "audit",
    line: "  audit    CI-usable ontology lint: doctor checks with non-zero exit on violations.",
    detailLines: [
      "             --folder <name>   Restrict the scan to one top-level vault folder.",
      "             --json             Emit structured JSON instead of console text.",
      "             --suggest-fields   Report undeclared observed fields and enum-value drift.",
    ],
  },
  { name: "lint", line: "  lint     Check vault link health: broken [[wikilinks]] and orphan notes." },
  { name: "link", line: "  link     Bridge an external repo to scoped vault folders via gitignored symlinks." },
  { name: "semantic", line: "  semantic Native markdown semantic index/search/get commands." },
  { name: "mcp", line: "  mcp      Start the read/status MCP stdio server." },
  {
    name: "hook",
    line: "  hook     Vault guard hooks for Claude Code PreToolUse / PostToolUse events.",
    detailLines: [
      "             pre-tool-use  Read PreToolUse JSON from stdin; block unregistered folder creation.",
      "             post-tool-use Read PostToolUse JSON from stdin; audit frontmatter + trigger graph build.",
    ],
  },
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

function runtimeChoices(registry: HarnessSurfaceRegistry): string {
  return ["auto", "all", ...registry.hosts.map((host) => host.runtime)].join("|");
}

export function cliUsageText(registry: HarnessSurfaceRegistry = harnessSurfaceRegistry): string {
  const runtime = runtimeChoices(registry);
  return `
oh-my-second-brain — Oh My Second Brain convention layer for Obsidian vaults

Usage:
  oh-my-second-brain setup [--vault <path>] [--yes] [--suggest-fields] [--install-claude]
  oh-my-second-brain install [--vault <path>] [--runtime <${runtime}>] [--dry-run] [--execute] [--yes] [--json]
  oh-my-second-brain uninstall [--runtime <all|${registry.hosts.map((host) => host.runtime).join("|")}>] [--dry-run] [--execute] [--yes] [--json]
  oh-my-second-brain update [--check] [--dry-run] [--yes] [--runtime <${runtime}>] [--vault <path>]
  oh-my-second-brain doctor [--vault <path>] [--verbose] [--json] [--max <n>]
  oh-my-second-brain audit [--vault <path>] [--folder <name>] [--json] [--suggest-fields]
  oh-my-second-brain lint [--vault <path>] [--verbose] [--json]
  oh-my-second-brain link --vault <path> --folder <name> [--folder <name> ...] [--no-convention-note]
  oh-my-second-brain semantic <status|sync|query|search|vsearch|get|multi-get|collection> [options]
  oh-my-second-brain mcp [--vault <path>]
  oh-my-second-brain hook pre-tool-use [--vault <path>]
  oh-my-second-brain hook post-tool-use [--vault <path>]

Compatibility alias: oms <command>

Commands:
${commandLines(registry)}

Options:
  --vault <path>   Path to the vault root (default: current directory).
  --yes            Non-interactive setup, uninstall confirmation, or update execution.
  --suggest-fields During setup --yes, add conservative observed frontmatter fields to concepts.
  --install-claude Print Claude Code plugin install and MCP registration commands (dry-run).
  --runtime <name> Select host runtime (default: auto for install, all for uninstall).
  --dry-run        Preview host config changes without writing files.
  --execute        Allow external host CLIs such as \`claude\` to run when available.
  --verbose        doctor/lint: list every affected note instead of a summary.
  --json           doctor/lint/audit: emit machine-readable output as JSON.
  --max <n>        doctor --verbose: max notes listed per concept (default 50).
  --folder <name>  audit: restrict scan; link: vault folder/subpath to expose (repeatable for link).
  --no-convention-note
                  link: skip writing the managed OMS usage block to AGENTS.md.
`;
}

export function printUsage(): void {
  console.log(cliUsageText());
}
