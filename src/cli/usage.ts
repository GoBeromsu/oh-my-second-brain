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
      "             Apply only with `setup --yes --approved-digest <shown-digest>`.",
      "             --template-folder <path>   Discover templates in this safe vault-relative folder.",
      "             --embedding-default       Install the pinned local embedding model (EmbeddingGemma-300M, 768d).",
      "             --embedding-descriptor <path>  Install an operator-supplied model descriptor instead.",
      "             --embedding-no-default    Waive model installation; vector search stays unavailable.",
    ],
  },
  { name: "install", line: "  install  Install Oh My Second Brain host adapters and MCP registration." },
  { name: "uninstall", line: "  uninstall Remove Oh My Second Brain host adapters and managed pointer last." },
  { name: "update", line: "  update   Check for or apply an explicit package update, then refresh host adapters." },
  { name: "reconcile", line: "  reconcile Re-stamp selected hosts from the strict global vault pointer." },
  {
    name: "doctor",
    line: "  doctor   Diagnose template authority, projection signatures, and migration state.",
    detailLines: [
      "             --max-per-template <n>  Cap reported findings for each stable template ID.",
    ],
  },
  {
    name: "audit",
    line: "  audit    Fail-closed validation of resolved templates and the derived note index.",
    detailLines: [
      "             --folder <name>   Restrict the scan to one top-level vault folder.",
      "             --json             Emit structured JSON instead of console text.",
    ],
  },
  { name: "lint", line: "  lint     Check vault link health: broken [[wikilinks]] and orphan notes." },
  { name: "link", line: "  link     Bridge an external repo to scoped vault folders via gitignored symlinks." },
  {
    name: "linkify",
    line: "  linkify  Propose [[wikilinks]] to template-bound notes across existing notes; report-only by default.",
    detailLines: [
      "             --folder <name>   Restrict the scan and writes to one top-level vault folder.",
      "             --apply --yes     Rewrite notes in place; --apply alone refuses and writes nothing.",
    ],
  },
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
  oh-my-second-brain setup [--vault <path>] [--template-folder <path>]
                           [--dry-run | --yes --approved-digest <sha256:...>] [--install-claude]
                           [--embedding-default | --embedding-descriptor <path> | --embedding-no-default]
  oh-my-second-brain install [--vault <path>] [--runtime <${runtime}>] [--dry-run] [--execute] [--yes] [--json]
  oh-my-second-brain uninstall [--runtime <all|${registry.hosts.map((host) => host.runtime).join("|")}>] [--dry-run] [--execute] [--yes] [--json]
  oh-my-second-brain update [--check] [--dry-run] [--yes] [--runtime <${runtime}>] [--vault <path>]
  oh-my-second-brain reconcile [--runtime <${runtime}>] [--dry-run] [--execute] [--yes] [--json]
  oh-my-second-brain doctor [--vault <path>] [--verbose] [--json] [--max <n>]
  oh-my-second-brain audit [--vault <path>] [--folder <name>] [--json]
  oh-my-second-brain lint [--vault <path>] [--verbose] [--json]
  oh-my-second-brain link --vault <path> --folder <name> [--folder <name> ...] [--no-convention-note]
  oh-my-second-brain linkify [--vault <path>] [--folder <name>] [--apply --yes]
  oh-my-second-brain semantic <query|status|get|multi-get|vsearch|search|sync|update|embed|collection|context|cleanup|serve|http> [options]
  oh-my-second-brain mcp [--vault <path>]
  oh-my-second-brain hook pre-tool-use [--vault <path>]
  oh-my-second-brain hook post-tool-use [--vault <path>]

Compatibility alias: oms <command>

Commands:
${commandLines(registry)}

Options:
  --vault <path>   Path to the vault root (default: current directory).
  --yes            setup: apply only with --approved-digest from an earlier dry-run; confirms uninstall or update execution.
  --approved-digest <sha256:...>
                  setup: exact digest shown by \`setup --dry-run\`; required with --yes and never generated by --yes.
  --template-folder <path>
                  setup: safe vault-relative Obsidian template folder, bound into dry-run/apply approval.
  --install-claude Print Claude Code plugin install and MCP registration commands (dry-run).
  --runtime <name> Select host runtime (default: auto for install, all for uninstall).
  --dry-run        setup: print the proposal and approval digest without writing; other commands preview host config changes.
  --execute        Allow external host CLIs such as \`claude\` to run when available.
  --verbose        doctor/lint: list every affected note instead of a summary.
  --json           doctor/lint/audit: emit machine-readable output as JSON.
  --folder <name>  audit/linkify: restrict scan; link: vault folder/subpath to expose (repeatable for link).
  --apply          linkify: rewrite notes in place; must be combined with --yes.
  --no-convention-note
                  link: skip writing the managed OMS usage block to AGENTS.md.
  --embedding-default
                  setup: download and verify the pinned EmbeddingGemma-300M model into the
                  user-level cache, then select it for \`oms embed\` and vector search without
                  requiring OMS_EMBEDDING_PROVIDER / OMS_EMBEDDING_MODEL.
  --embedding-descriptor <path>
                  setup: install an operator-supplied model descriptor (SHA-256 verified).
  --embedding-no-default
                  setup: explicitly install no model; lexical search still works.
`;
}

export function printUsage(): void {
  console.log(cliUsageText());
}
