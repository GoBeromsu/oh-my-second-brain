# Host Asset Contract

Oh My Second Brain keeps shared skills in `assets/skills/` and host-specific runtime assets in explicit directories under `assets/`. There is no adapter bundle directory.

| Host | Manifest/config | Host assets | Installation destination |
|---|---|---|---|
| Claude Code | Root `.claude-plugin/plugin.json` and `.mcp.json` | `assets/claude/CLAUDE.md`, `assets/claude/hooks/` | Plugin root; guard hooks are installed through `~/.claude/settings.json`. |
| Codex | Root `.codex-plugin/plugin.json` and `.mcp.codex.json` | `assets/codex/AGENTS.md`, `assets/codex/rules/oms.md`, optional `assets/codex/agents/oms-reviewer.toml` | `~/.codex/plugins/oms/AGENTS.md`, `~/.codex/rules/oms.md`, `~/.codex/skills/oms-*`, and, when that role is owned, `~/.codex/agents/oms-reviewer.toml` plus `~/.codex/agents/oms-reviewer.provenance.json`. |
| Hermes | `assets/hermes-manifest.json` | `assets/hermes/SOUL.md`, `assets/hermes/README.md` | `~/.hermes/adapters/oms/`, `~/.hermes/skills/knowledge-management/oms/`, and `~/.hermes/config.yaml`. |
| Gajae-Code | Marketplace-plugin convention | Generated root `skills/` mirror | The installed npm package root, where GJC discovers `skills/<name>/SKILL.md`. |

Claude's manifest keeps an explicit skill array. Codex's manifest keeps one shared skill-directory declaration. Both resolve `./assets/skills/` inside the repository-root plugin. The eight skills are `distill`, `doctor`, `interview`, `link`, `search`, `status`, `template`, and `write`.

`assets/skills/` remains the sole authored skill source. The root `skills/` tree is a committed generated mirror for GJC only: it cannot be a symlink because npm drops that symlink from packed artifacts. `npm run sync:skills` regenerates it, and the architecture gate requires matching directories and byte-identical `SKILL.md` files.

The MCP server is started with `oms serve mcp`; `oms serve http` starts the HTTP surface. Neither server creates a vault engine store merely by starting. Claude uses `.mcp.json`, Codex uses `.mcp.codex.json`, and Hermes receives its registration in `~/.hermes/config.yaml`.

All hosts expose the same five MCP tools: `write`, `search`, `link`, `status`, and `doctor`. Skills are host workflows, not tool names. `interview` and `template` are tool-less. The `write` tool does not write ordinary notes. It guides a new or existing note, then checks and completes the agent's saved file. Its mutations record interview answers and publish approved contract configuration. See [the CLI map](./cli-map.md).

Agents write and repair note files after receiving approved guidance. OMS checks and completes those saved notes. A path that is not yet chosen is a question, and that question does not issue a check task. Search stays read-only when policy is missing, invalid, or mid-publish. The v4 default layer is always on, individual templates only add constraints, and a note with no individual template is valid. Contract publication commits only the approved diff, by compare-and-swap.

Status and template listings report runtime history for the current host and vault only. This history is stored outside the vault, not in the engine store or convention controls. Report logging failures and observation gaps explicitly; do not merge another host's history or treat absent events as inactivity.

The initial host notice is exactly `템플릿에 변경이 있습니다` with exactly `확인하기` and `나중에`. It shows no template name, hash, or change class. `나중에` is host-only and makes no server call or ledger mutation. `확인하기` starts the config interview at `write { op: "template", mode: "interview-next", proposals }`. Forward the server-returned question, request, and compare-and-swap fields without inventing names, and send the same `proposals` on `interview-next`, `interview-answer`, and `commit-contracts`. Commit only after the user approves the exact final digest. Long-lived hosts surface a returned `templateNotice` even when boot guidance is stale. The `interview` skill owns that one-question lifecycle. A general question, an unknown value, a note error, an unmanaged property, or a search does not start it.

OMS does not parse or execute Templater, JavaScript, or a private token language. The agent may interpret an external template. The approved v4 policy is the contract.

## Separate reviewer

Completion requires a real separate reviewer: another role or conversation, a non-modification instruction, the request digest, a terminal result, and the same evaluation inputs before and after that review. The host launches it. OMS adds no model provider and runs no reviewer daemon. This page states that responsibility. It is not a host-smoke result.

A value supplied by a host tool or event is H. When the agent transcribes or interprets that value into the completion request, the carried value is T. A digest OMS recomputes from bytes is O. Transcribed H is T.

A definition byte match compares the shipped reviewer file with the installed file. It shows those bytes are the same. It does not show that the host loaded the file, launched the role, or enforced a tool restriction. OMS does not certify reviewer independence. The isolation these mechanisms actually support is instruction-only. Before-and-after agreement covers the evaluation inputs, not the whole vault. Claude's write hook is fail-open. Codex and Hermes declare no write hook. None of those hooks is a hard save block.

| Host | Separate review | Definition OMS can compare |
|---|---|---|
| Claude | Plugin role `agents/oms-reviewer.md`, declared by the plugin manifest as `./agents/oms-reviewer.md`. | The plugin file is the shipped role. A documented tool allowlist is not enforcement. No second install path under the Claude home is declared. |
| Codex | A generic separate subagent is a valid review. The optional owned file `~/.codex/agents/oms-reviewer.toml` may be used when the host discovers it. | Optional shipped file `assets/codex/agents/oms-reviewer.toml`, installed only as an owned copy. Fields are `name`, `description`, `developer_instructions`, and `sandbox_mode`. |
| Hermes | Fresh `delegate_task` conversation. Inherited tools are the supported instruction-only path. Completion waits for the terminal result. | No reviewer asset. A definition check does not apply. |

Codex custom-agent discovery can fail. The valid fallback is still a real generic separate reviewer, not a review written in the same conversation. `sandbox_mode` does not cover inherited MCP access. An empty MCP server map is not a claim that inherited servers were removed. Hermes does not need a named tool-denial list for that fresh delegation to count.

## Host lifecycle

Host lifecycle is explicit: `oms host install|remove|sync|status`. Package lifecycle is separate: `oms package check|update` never syncs hosts as a side effect. Model lifecycle is `oms model install|select|waive|status`. OMS exposes no host launcher, and bridge management is limited to `oms bridge add|remove|status` rather than an invented repair action.

To add a host, add a clearly named `assets/<host>/` directory for host-only files, preserve shared skills in `assets/skills/`, declare every shipped path in the harness registry, and keep installer destinations explicit.
