# Host Asset Contract

Oh My Second Brain keeps shared skills in `assets/skills/` and host-specific runtime assets in explicit directories under `assets/`. There is no adapter bundle directory.

| Host | Manifest/config | Host assets | Installation destination |
|---|---|---|---|
| Claude Code | Root `.claude-plugin/plugin.json` and `.mcp.json` | `assets/claude/CLAUDE.md`, `assets/claude/hooks/` | Plugin root; the guard hook is registered in `~/.claude/settings.json` as PreToolUse entries for `Write|Edit|MultiEdit|NotebookEdit` and `Read|Grep|Glob`. |
| Codex | Root `.codex-plugin/plugin.json` and `.mcp.codex.json` | `assets/codex/AGENTS.md`, `assets/codex/rules/oms.md` | `~/.codex/plugins/oms/AGENTS.md`, `~/.codex/rules/oms.md`, and `~/.codex/skills/oms-*`. |
| Hermes | `assets/hermes-manifest.json` | `assets/hermes/SOUL.md`, `assets/hermes/README.md` | `~/.hermes/adapters/oms/`, `~/.hermes/skills/knowledge-management/oms/oms-*`, and `~/.hermes/config.yaml`. |
| Gajae-Code | Marketplace-plugin convention (`gjc plugin install oms@oh-my-second-brain`) | Generated root `skills/` mirror | The installed npm package root, where GJC discovers `skills/<name>/SKILL.md`. |

Claude's manifest keeps an explicit skill array. Codex's manifest keeps one shared skill-directory declaration. Both resolve `./assets/skills/` inside the repository-root plugin. The six skills are `distill`, `doctor`, `interview`, `search`, `setup`, and `write`.

`assets/skills/` remains the sole authored skill source. The root `skills/` tree is a committed generated mirror for GJC only: it cannot be a symlink because npm drops that symlink from packed artifacts. `npm run sync:skills` regenerates it, and the architecture gate requires matching directories and byte-identical `SKILL.md` files.

The MCP server is started with `oms serve mcp`; `oms serve http` starts the HTTP surface. Neither server creates a vault engine store merely by starting. Claude uses `.mcp.json`, Codex uses `.mcp.codex.json`, and Hermes receives its registration in `~/.hermes/config.yaml`.

All hosts expose the same four MCP tools: `write`, `search`, `interview`, and `doctor`. Skills are host workflows, not tool names. `distill` and `setup` are tool-less. The `write` tool takes `{path, content, template?, ifMatch?, check?}`: the agent supplies the whole note, and OMS judges it against the sealed contract and saves it unless a safety refusal denies it, returning any contract findings as warnings. See [the CLI map](./cli-map.md).

Agents write and repair notes. Only a safety refusal denies a write; a denial, a missing or stale `ifMatch`, or an unverified target leaves the file unchanged. A saved write returns its contract findings as `{field, kind}` warnings with one guidance command, and a denial carries one too. OMS has no completion operation or reviewer handshake. Search stays read-only and does not depend on the contract. Sealing needs the owner's confirmation: the interactive `oms setup` or `oms interview`, `oms setup --answers` through the `setup` skill, or MCP `interview` `op: seal` on a confirmed proposal.

MCP input schemas expose operation names and arguments through top-level `properties`; their `oneOf` branches still enforce operation-specific combinations and approval requirements. Hosts need not guess arguments from tool descriptions.

Search query responses include at most 20 facet values, with a receipt warning when the summary omits values. Hit `limit`, `totalCount`, and cursor pagination remain independent of this summary; the hit cursor does not page facets. This bounds facet cardinality, not the byte length of arbitrary field values.

Explicit frontmatter exploration uses the same `search` tool with `op: "query"` and `observed: {field?, discover?}`. `field` maps observed keys to the existing scalar/list predicates (`in`, `contains`, `containsAll`, and range operators); it does not declare fields or relax `axes.field`. `discover: {limit: 20}` pages keys; `discover: {key: "subject", limit: 20, cursor?}` pages values for one key. Query text is optional for observed-only calls, and `limit: 0` suppresses note hits. When discovery is requested with zero note hits, the ordinary `facets` array is empty so unbounded legacy facet values cannot overwhelm the bounded discovery page; ordinary non-observed responses are unchanged. Responses add `observed.discovery` only when explicitly requested, with `kind`, `keys` or `values`, exact `totalCount`, `omittedCount`, and a separate opaque cursor. Counts cover matching notes before hit pagination/candidate limits; canonical strings are trimmed/lowercased. Discovery pages are capped at 100 entries and 32 KiB of serialized JSON, omit entries above 512 UTF-8 bytes explicitly, and preserve exact values across page boundaries. Each value facet includes a JSON-safe `selection` predicate; apply it under `observed.field[key]` while preserving the discovery request's lexical query, collection and predicates (merge with a same-key range/membership predicate) to reproduce its count and note set with unchanged sources. It selects a typed canonical value, not a self-contained query scope; replacing a prior predicate or changing the query changes the scope and can change the count. Its shape is `{exact: {valueType, value}}`, with `valueType` one of `string`, `number`, `boolean`, or `date`. Exact date values are canonical ISO strings including milliseconds and `Z`, even in the direct API. Type/value mismatches and noncanonical or invalid dates are rejected; strings retain the store's existing trim/case normalization. Legacy membership/range and declared-axis comparisons retain their prior behavior. A changed source snapshot requires restarting discovery. Vector/HyDE/expansion and multi-collection discovery are rejected clearly in this first observed path.

Status reports runtime history for the current host and vault only. This history is stored outside the vault, not in the engine store. Report logging failures and observation gaps explicitly; do not merge another host's history or treat absent events as inactivity.

OMS does not parse or execute Templater, JavaScript, or a private token language. Templates stay the user's own Markdown; the sealed contract records what they declare.

## No reviewer handshake

There is no completion operation and no reviewer protocol. An allowed `write` with no warnings means the note fits the sealed structure; judging whether a note is worth keeping, and repairing it, belong to the user and the agent. OMS adds no model provider, launches no role, and runs no reviewer daemon.

Nothing is installed under `~/.codex/agents/` or declared as a plugin agent any more. `oms setup host remove` still deletes a role and provenance record an earlier version installed, and only when the OMS-written provenance record proves it owns them; a foreign agent file is left in place and reported.

Claude's guard hook runs `oms hook pre`: it denies a write inside the configured vault only on a safety refusal, and allows any other finding, or a judge that cannot run, with a warning. It also denies reads, searches, and writes under `~/.oms/` and other OMS control paths. Codex and Hermes declare no write hook; their notes are judged only when written through MCP `write`.

## Host lifecycle

Host lifecycle is explicit: `oms setup host install|remove|sync|status`. Package lifecycle is separate: `oms setup package check|update` never syncs hosts as a side effect. Model lifecycle is `oms setup model install|select|waive|status`. OMS exposes no host launcher, and bridge management is limited to `oms setup bridge add|remove|status` rather than an invented repair action.

To add a host, add a clearly named `assets/<host>/` directory for host-only files, preserve shared skills in `assets/skills/`, declare every shipped path in the harness registry, and keep installer destinations explicit.
