# Install Oh My Second Brain

Oh My Second Brain v0 is distributed as one npm/GitHub-release package that contains the CLI/runtime, the default ontology, host adapter assets, host-native skill/rule bundles, and shell installers. Claude Code, Codex, and Hermes install Oh My Second Brain host surfaces backed by the same MCP write/retrieve runtime. Legacy runtime IDs remain `oms` for compatibility.

## Prerequisites

- Node.js 20 or newer.
- `npm` on `PATH`.
- An Obsidian vault, or any folder of Markdown notes.
- Optional host CLIs: `claude`, `codex`, `hermes`.

## One-line install

The installer uses the published npm package (`oh-my-second-brain@0.1.9`) by default:

```bash
curl -fsSL https://raw.githubusercontent.com/GoBeromsu/oh-my-second-brain/main/scripts/install.sh | bash
```

Useful overrides:

```bash
# Pick one host instead of auto-detection.
curl -fsSL https://raw.githubusercontent.com/GoBeromsu/oh-my-second-brain/main/scripts/install.sh | bash -s -- --runtime claude

# Install every host adapter and point Oh My Second Brain at a specific vault.
curl -fsSL https://raw.githubusercontent.com/GoBeromsu/oh-my-second-brain/main/scripts/install.sh | bash -s -- --runtime all --vault /path/to/vault

# Also execute external host CLIs where available, e.g. claude plugin/mcp commands.
curl -fsSL https://raw.githubusercontent.com/GoBeromsu/oh-my-second-brain/main/scripts/install.sh | bash -s -- --runtime all --vault /path/to/vault --execute
```

Environment knobs:

| Variable | Meaning |
| --- | --- |
| `OMS_PACKAGE_SPEC` | npm package spec or tarball URL to install globally |
| `OMS_INSTALL_RUNTIME` | `auto`, `all`, `claude`, `codex`, or `hermes` |
| `OMS_VAULT` | vault path used for MCP registration |
| `OMS_EXECUTE_EXTERNAL=1` | allow host CLI commands such as `claude plugin install` |
| `OMS_UPDATE_NOTICE=0` | disable automatic update-available notices on normal CLI commands |
| `OMS_UPDATE_NOTICE_TIMEOUT_MS` | timeout for the non-blocking update notice check |

## CLI install

From npm or a checkout:

```bash
npm install -g oh-my-second-brain@0.1.9
oh-my-second-brain install --runtime all --vault /path/to/vault --dry-run
oh-my-second-brain install --runtime all --vault /path/to/vault --yes
```

Runtime selection follows the Ouroboros pattern:

1. Explicit `--runtime` wins.
2. `auto` detects `claude`, `codex`, and `hermes` on `PATH`.
3. If nothing is detected, `auto` defaults to Claude Code for conservative first-run behavior; use `--runtime all` to install every host surface.
4. `all` installs every known adapter surface.

## What install writes

| Host | Install behavior |
| --- | --- |
| Claude Code | Installs the plugin-owned `.mcp.json` surface; removes stale `oms` registrations across local/project/user scopes; with `--execute`, adds the OMS marketplace and installs `oms@oms` through it, falling back to the local plugin path when the marketplace flow can't complete. |
| Codex | Installs `~/.codex/rules/oms.md`, `~/.codex/skills/oms-*`, copies adapter files to `~/.codex/plugins/oms`, and writes a managed `[mcp_servers.oms]` block plus `OMS_AGENT_RUNTIME=codex` env in `~/.codex/config.toml`. |
| Hermes | Installs `~/.hermes/skills/knowledge-management/oms/`, copies adapter files to `~/.hermes/adapters/oms`, and writes `mcp_servers.oms` in `~/.hermes/config.yaml`. |

Host writes keep the legacy `oms` namespace for backward-compatible MCP/skill IDs and are reversible with `oh-my-second-brain uninstall` (or the `oms` alias). Each runtime is installed independently: if one host fails, the others still complete.

Hermes config writes are an upsert, so comments and key ordering in `~/.hermes/config.yaml` survive an install or update.

### Claude Code marketplace

OMS publishes a marketplace manifest at the repo root (`.claude-plugin/marketplace.json`), so Claude Code can discover and install it natively:

```bash
claude plugin marketplace add GoBeromsu/oh-my-second-brain
claude plugin install oms@oms
```

A local checkout wins over the published repo, which keeps offline and dev installs working; the plain `claude plugin install <path>` route stays as the fallback.

Claude keeps `autoUpdate` off for third-party marketplaces, and OMS does not change that for you. If you want this marketplace to refresh itself, set `extraKnownMarketplaces.<name>.autoUpdate` to `true` in `~/.claude/settings.json`. Otherwise run `claude plugin marketplace update` when you want a refresh. The install output prints this reminder.

## Update

Preview the package update and host adapter reconciliation first:

```bash
oh-my-second-brain update --dry-run --runtime all --vault /path/to/vault
```

Apply the latest npm package and refresh selected host adapters:

```bash
oh-my-second-brain update --yes --runtime all --vault /path/to/vault
```

`update` checks `oh-my-second-brain@latest`, then plans `npm install -g oh-my-second-brain@latest` plus a post-update adapter reconciliation. It does not mutate package or host config unless `--yes` is provided. Use `--execute` only when you want reconciliation to call external host CLIs where available.

Normal CLI commands such as `setup`, `install`, `uninstall`, and `doctor` also print a short stderr notice when a newer npm version is available. Set `OMS_UPDATE_NOTICE=0` to silence that check in CI or release smoke environments.

The MCP server carries the same nudge. At boot it reads a 24-hour cache (`~/.oms/update-notice-cache.json` by default) and, when a newer version is stamped there, appends one line to the server `instructions` your host sees. The registry lookup itself runs in a bounded background refresh, never on the startup path, so an offline or slow registry can't delay the server. `OMS_UPDATE_NOTICE=0` silences it here too.

## Legacy setup flow

`setup` still adopts a vault into the Oh My Second Brain ontology and can print the Claude Code plan:

```bash
oh-my-second-brain setup --vault /path/to/vault --yes --install-claude
```

Interactive setup now interviews folder axes, concept bindings, optional observed frontmatter fields, and retrieval lenses:

```bash
oh-my-second-brain setup --vault /path/to/vault --suggest-fields
```

Setup does not modify vault notes. It writes `.oms/taxonomy.yaml`, preserves existing `.oms/concepts/`, and only adds selected observed fields when `--suggest-fields` is enabled.

Typical printed commands look like:

```bash
claude plugin install /path/to/oh-my-second-brain/adapters/claude-code
# MCP is declared by the installed plugin in adapters/claude-code/.mcp.json.
```

## Uninstall

Preview first:

```bash
oh-my-second-brain uninstall --runtime all --dry-run
```

Remove host registrations and adapter files:

```bash
oh-my-second-brain uninstall --runtime all --yes
```

One-line uninstall:

```bash
curl -fsSL https://raw.githubusercontent.com/GoBeromsu/oh-my-second-brain/main/scripts/uninstall.sh | bash -s -- --yes
```

The uninstaller removes Oh My Second Brain host registrations and adapter files. It does **not** remove vault notes or `vault/.oms/` ontology data. Pass `--keep-package` to the shell uninstaller if you want to keep the globally installed package.

## Link existing notes

OMS treats `term` as a first-class concept: notes in `terms/` define your vocabulary once, and their `aliases` frontmatter lists the other surface forms that should point back. Wikilinks resolve through those aliases, so `[[some-alias]]` reaches the term note.

To retrofit links across notes you already wrote:

```bash
# Report only. Nothing is written.
oh-my-second-brain linkify --vault /path/to/vault

# Restrict the scan to one top-level folder.
oh-my-second-brain linkify --vault /path/to/vault --folder notes

# Rewrite in place. Both flags are required.
oh-my-second-brain linkify --vault /path/to/vault --apply --yes
```

Hosts can do the same note by note through the `oms_link_suggest` (read-only) and `oms_link_apply` (writes accepted candidates) MCP tools. Nothing is linked behind your back: new notes are composed already linked, and existing notes change only when you ask.

## Verify the install

```bash
oh-my-second-brain doctor --vault /path/to/vault
oh-my-second-brain semantic sync --vault /path/to/vault --collection vault
oh-my-second-brain semantic query "what should I retrieve?" --vault /path/to/vault
oh-my-second-brain semantic context add vault "Prefer durable notes with reusable evidence." --vault /path/to/vault
oh-my-second-brain semantic ls vault --vault /path/to/vault
oh-my-second-brain semantic doctor --vault /path/to/vault
oh-my-second-brain install --runtime all --vault /path/to/vault --dry-run
claude plugin validate adapters/claude-code
```

Inside a host runtime, verify the MCP server by listing MCP tools or asking for Oh My Second Brain graph/status. The server exposes status, graph build, context retrieval, native OMS semantic-index sync, qmd-compatible semantic query/status aliases, `qmd://` document resources, semantic document rehydration, axis retrieval, lazy note loading, contract validation, and gated write tools. OMS does not require the `qmd` binary; `oms semantic doctor` now reports the built-in SQLite/FTS/vector backend and optional GGUF model path diagnostics.
