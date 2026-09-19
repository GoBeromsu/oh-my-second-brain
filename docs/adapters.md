# Host Asset Contract

Oh My Second Brain keeps shared skills in `assets/skills/` and host-specific runtime assets in explicit directories under `assets/`. There is no adapter bundle directory.

| Host | Manifest/config | Host assets | Installation destination |
|---|---|---|---|
| Claude Code | Root `.claude-plugin/plugin.json` and `.mcp.json` | `assets/claude/CLAUDE.md`, `assets/claude/hooks/` | Plugin root; guard hooks are installed through `~/.claude/settings.json`. |
| Codex | Root `.codex-plugin/plugin.json` and `.mcp.codex.json` | `assets/codex/AGENTS.md`, `assets/codex/rules/oms.md` | `~/.codex/plugins/oms/AGENTS.md`, `~/.codex/rules/oms.md`, and `~/.codex/skills/oms-*`. |
| Hermes | `assets/hermes-manifest.json` | `assets/hermes/SOUL.md`, `assets/hermes/README.md` | `~/.hermes/adapters/oms/`, `~/.hermes/skills/knowledge-management/oms/`, and `~/.hermes/config.yaml`. |
| Gajae-Code | Marketplace-plugin convention | Generated root `skills/` mirror | The installed npm package root, where GJC discovers `skills/<name>/SKILL.md`. |

Claude's manifest retains its explicit skill array; Codex's manifest retains its single shared skill-directory declaration. Both resolve `./assets/skills/` inside the repository-root plugin.

`assets/skills/` remains the sole authored skill source. The root `skills/` tree is a committed generated mirror for GJC only: it cannot be a symlink because npm drops that symlink from packed artifacts. `npm run sync:skills` regenerates it, and the architecture gate requires matching directories and byte-identical `SKILL.md` files.

The MCP server is started with `oms serve mcp`; `oms serve http` starts the HTTP surface. Neither server creates a vault engine store merely by starting. Claude uses `.mcp.json`, Codex uses `.mcp.codex.json`, and Hermes receives its registration in `~/.hermes/config.yaml`.

All hosts expose the same five MCP tools. An explicitly selected template folder
is the source scope: every `.md` beneath it is a census candidate. No per-file
registration or auto/manual folder mode is required. The folder-scope operation
remains under `write`; explicit source authoring uses
`oms template add --id <id> --from <file>`, while update, move, remove, and
other source mutations remain separate guarded operations.

Status and template listings report runtime history for the current host and vault only. This history is stored outside the vault, not in the engine store or convention controls. Report logging failures and observation gaps explicitly; do not merge another host's history or treat absent events as inactivity.

Review is a verify-only source census and contract flow: the source stays at
its current path and only user-confirmed `.oms` controls are published. The
initial host notice is exactly `템플릿에 변경이 있습니다` with exactly
`확인하기` and `나중에`; do not display a template name, hash, or change class.
`나중에` is host-only and makes no server call or ledger mutation.
`확인하기` starts `write { op: "template", mode: "interview-next" }`.
Submit answers with `interview-answer`, resume from the server-returned next
question, and use `commit-contracts` only after all necessary questions and
the user's approval of the exact final digest. Forward server-returned
question/request/CAS fields without inventing names. Long-lived hosts surface a
returned `templateNotice` even when boot guidance is stale.

The two-tier freshness gate checks shared authority first, then marks only a
changed source's dependent template pending; unrelated template writes remain
available. Shared-authority failures remain fail-closed for the whole vault.
The derived contract includes metadata and supported body nodes,
including ATX headings, fenced code blocks, ordered/unordered list runs outside
fences, and `<!-- oms:content -->`, not an assertion that arbitrary Markdown is
enforced. Placement is not required for review; at note creation, an explicit
caller folder takes precedence over the taxonomy default, then `ask`.

Host agents may propose Core-template copies of external templates, but the kernel never transpiles or executes Templater. Inspect `renderer` and `filledBy` contract metadata before note creation. Ask for missing Obsidian-filled values; an external body or `none` renderer requires another Core template rather than raw script copying. Existing-note contract proposals show sample coverage and remain subject to exact approval and verified postconditions.

Host lifecycle is explicit: `oms host install|remove|sync|status`. Package
lifecycle is separate: `oms package check|update` never syncs hosts as a side
effect. Model lifecycle is `oms model install|select|waive|status`. OMS exposes
no host launcher, and bridge management is limited to `oms bridge
add|remove|status` rather than an invented repair action.

To add a host, add a clearly named `assets/<host>/` directory for host-only files, preserve shared skills in `assets/skills/`, declare every shipped path in the harness registry, and keep installer destinations explicit.
