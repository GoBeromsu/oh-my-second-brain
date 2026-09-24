# Host Asset Contract

Oh My Second Brain keeps shared skills in `assets/skills/` and host-specific runtime assets in explicit directories under `assets/`. There is no adapter bundle directory.

| Host | Manifest/config | Host assets | Installation destination |
|---|---|---|---|
| Claude Code | Root `.claude-plugin/plugin.json` and `.mcp.json` | `assets/claude/CLAUDE.md`, `assets/claude/hooks/` | Plugin root; guard hooks are installed through `~/.claude/settings.json`. |
| Codex | Root `.codex-plugin/plugin.json` and `.mcp.codex.json` | `assets/codex/AGENTS.md`, `assets/codex/rules/oms.md` | `~/.codex/plugins/oms/AGENTS.md`, `~/.codex/rules/oms.md`, and `~/.codex/skills/oms-*`. |
| Hermes | `assets/hermes-manifest.json` | `assets/hermes/SOUL.md`, `assets/hermes/README.md` | `~/.hermes/adapters/oms/`, `~/.hermes/skills/knowledge-management/oms/`, and `~/.hermes/config.yaml`. |
| Gajae-Code | Marketplace-plugin convention | Generated root `skills/` mirror | The installed npm package root, where GJC discovers `skills/<name>/SKILL.md`. |

Claude's manifest keeps an explicit skill array. Codex's manifest keeps one shared skill-directory declaration. Both resolve `./assets/skills/` inside the repository-root plugin. The eight skills are `distill`, `doctor`, `interview`, `link`, `search`, `status`, `template`, and `write`.

`assets/skills/` remains the sole authored skill source. The root `skills/` tree is a committed generated mirror for GJC only: it cannot be a symlink because npm drops that symlink from packed artifacts. `npm run sync:skills` regenerates it, and the architecture gate requires matching directories and byte-identical `SKILL.md` files.

The MCP server is started with `oms serve mcp`; `oms serve http` starts the HTTP surface. Neither server creates a vault engine store merely by starting. Claude uses `.mcp.json`, Codex uses `.mcp.codex.json`, and Hermes receives its registration in `~/.hermes/config.yaml`.

All hosts expose the same five MCP tools: `write`, `search`, `link`, `status`, and `doctor`. Skills are host workflows, not tool names. `interview` and `template` are tool-less. The `write` tool does not write ordinary notes. `write { op: "guide" }` selects a contract for an explicit note path and returns a session locator; after the agent saves the file, `write { op: "check" }` reads those saved bytes through that locator and reports declared properties and headings with `semantic: "not-evaluated"`. Template mutations use `write { op: "template", mode: "publish-contract"|"acknowledge-source"|"relink-source" }` with an explicit `transactionId`. See [the CLI map](./cli-map.md).

Agents write and repair note files after receiving guidance. OMS checks those saved notes; it has no completion operation or reviewer handshake. A path that is not yet chosen is a question, and that question does not issue a check task. Search stays read-only when policy is missing, invalid, or mid-publish. The version-5 common contract is always on, has no Markdown file of its own, and holds exactly what the published document declares; explicitly registered templates inherit it and may add constraints, tighten them, or make an approved relaxation. A note with no individual template is valid under the common contract. Contract publication compare-and-swaps against the exact policy bytes now on disk.

MCP input schemas expose operation names and arguments through top-level `properties`; their `oneOf` branches still enforce operation-specific combinations and approval requirements. Hosts need not guess arguments from tool descriptions.

Search query responses include at most 20 facet values, with a receipt warning when the summary omits values. Hit `limit`, `totalCount`, and cursor pagination remain independent of this summary; the hit cursor does not page facets. This bounds facet cardinality, not the byte length of arbitrary field values.

Status and template listings report runtime history for the current host and vault only. This history is stored outside the vault, not in the engine store or convention controls. Report logging failures and observation gaps explicitly; do not merge another host's history or treat absent events as inactivity.

The initial host notice is exactly `템플릿에 변경이 있습니다` with exactly `확인하기` and `나중에`. It shows no template name, hash, or change class. `나중에` is host-only and makes no server call. `확인하기` runs `write { op: "template", mode: "review-sources" }`. A changed source can then be acknowledged only with its live reviewed digest or relinked only when the original is genuinely missing and the user supplies the exact candidate path; both mutations require an explicit `transactionId`. Long-lived hosts surface a returned `templateNotice` even when boot guidance is stale. A general question, an unknown value, a note error, an unmanaged property, or a search does not start source review.

OMS does not parse or execute Templater, JavaScript, or a private token language. The agent may interpret an external template. The version-5 policy is the contract.

## No reviewer handshake

There is no completion operation and no reviewer protocol. `write { op: "check" }` reports declared properties and headings against the published contract and returns `semantic: "not-evaluated"`; judging whether a note is worth keeping, and repairing it, belong to the user and the agent. OMS adds no model provider, launches no role, and runs no reviewer daemon.

Nothing is installed under `~/.codex/agents/` or declared as a plugin agent any more. `oms host remove` still deletes a role and provenance record an earlier version installed, and only when the OMS-written provenance record proves it owns them; a foreign agent file is left in place and reported.

Claude's write hook is fail-open. Codex and Hermes declare no write hook. None of those hooks is a hard save block, and a hook is advisory rather than a guarantee that a save was stopped.

## Host lifecycle

Host lifecycle is explicit: `oms host install|remove|sync|status`. Package lifecycle is separate: `oms package check|update` never syncs hosts as a side effect. Model lifecycle is `oms model install|select|waive|status`. OMS exposes no host launcher, and bridge management is limited to `oms bridge add|remove|status` rather than an invented repair action.

To add a host, add a clearly named `assets/<host>/` directory for host-only files, preserve shared skills in `assets/skills/`, declare every shipped path in the harness registry, and keep installer destinations explicit.
