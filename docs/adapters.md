# Host Asset Contract

Oh My Second Brain keeps shared skills in `assets/skills/` and host-specific runtime assets in explicit directories under `assets/`. There is no adapter bundle directory.

| Host | Manifest/config | Host assets | Installation destination |
|---|---|---|---|
| Claude Code | Root `.claude-plugin/plugin.json` and `.mcp.json` | `assets/claude/CLAUDE.md`, `assets/claude/hooks/` | Plugin root; the guard hook is registered in `~/.claude/settings.json` as PreToolUse entries for `Write|Edit|MultiEdit|NotebookEdit` and `Read|Grep|Glob`. |
| Codex | Root `.codex-plugin/plugin.json` and `.mcp.codex.json` | `assets/codex/AGENTS.md`, `assets/codex/rules/oms.md` | `~/.codex/plugins/oms/AGENTS.md`, `~/.codex/rules/oms.md`, and `~/.codex/skills/oms-*`. |
| Hermes | `assets/hermes-manifest.json` | `assets/hermes/SOUL.md`, `assets/hermes/README.md` | `~/.hermes/adapters/oms/`, `~/.hermes/skills/knowledge-management/oms/`, and `~/.hermes/config.yaml`. |
| Gajae-Code | Marketplace-plugin convention | Generated root `skills/` mirror | The installed npm package root, where GJC discovers `skills/<name>/SKILL.md`. |

Claude's manifest keeps an explicit skill array. Codex's manifest keeps one shared skill-directory declaration. Both resolve `./assets/skills/` inside the repository-root plugin. The seven skills are `distill`, `doctor`, `link`, `search`, `setup`, `status`, and `write`.

`assets/skills/` remains the sole authored skill source. The root `skills/` tree is a committed generated mirror for GJC only: it cannot be a symlink because npm drops that symlink from packed artifacts. `npm run sync:skills` regenerates it, and the architecture gate requires matching directories and byte-identical `SKILL.md` files.

The MCP server is started with `oms serve mcp`; `oms serve http` starts the HTTP surface. Neither server creates a vault engine store merely by starting. Claude uses `.mcp.json`, Codex uses `.mcp.codex.json`, and Hermes receives its registration in `~/.hermes/config.yaml`.

All hosts expose the same five MCP tools: `write`, `search`, `link`, `status`, and `doctor`. Skills are host workflows, not tool names. `distill` is tool-less. The `write` tool takes `{path, content, template?}`: the agent supplies the whole note, and OMS judges it against the sealed contract and saves it only when it is allowed. See [the CLI map](./cli-map.md).

Agents write and repair notes. A denied write leaves the file unchanged and returns `{field, kind}` violations and one guidance command. OMS has no completion operation or reviewer handshake. Search stays read-only and does not depend on the contract. Sealing happens only through the interactive `oms setup`; no host, skill, or MCP operation seals.

MCP input schemas expose operation names and arguments through top-level `properties`; their `oneOf` branches still enforce operation-specific combinations and approval requirements. Hosts need not guess arguments from tool descriptions.

Search query responses include at most 20 facet values, with a receipt warning when the summary omits values. Hit `limit`, `totalCount`, and cursor pagination remain independent of this summary; the hit cursor does not page facets. This bounds facet cardinality, not the byte length of arbitrary field values.

Status reports runtime history for the current host and vault only. This history is stored outside the vault, not in the engine store. Report logging failures and observation gaps explicitly; do not merge another host's history or treat absent events as inactivity.

OMS does not parse or execute Templater, JavaScript, or a private token language. Templates stay the user's own Markdown; the sealed contract records what they declare.

## No reviewer handshake

There is no completion operation and no reviewer protocol. An allowed `write` means the note fits the sealed structure; judging whether a note is worth keeping, and repairing it, belong to the user and the agent. OMS adds no model provider, launches no role, and runs no reviewer daemon.

Nothing is installed under `~/.codex/agents/` or declared as a plugin agent any more. `oms host remove` still deletes a role and provenance record an earlier version installed, and only when the OMS-written provenance record proves it owns them; a foreign agent file is left in place and reported.

Claude's guard hook runs `oms hook pre`: it denies a write inside the configured vault when the judge finds a violation, and allows it with a warning when the judge cannot run. It also denies reads and writes under `~/.oms/`. Codex and Hermes declare no write hook; their notes are judged only when written through MCP `write`.

## Host lifecycle

Host lifecycle is explicit: `oms host install|remove|sync|status`. Package lifecycle is separate: `oms package check|update` never syncs hosts as a side effect. Model lifecycle is `oms model install|select|waive|status`. OMS exposes no host launcher, and bridge management is limited to `oms bridge add|remove|status` rather than an invented repair action.

To add a host, add a clearly named `assets/<host>/` directory for host-only files, preserve shared skills in `assets/skills/`, declare every shipped path in the harness registry, and keep installer destinations explicit.
