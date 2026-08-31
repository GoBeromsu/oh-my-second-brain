# Installation

Oh My Second Brain is an npm package with an independent CLI, optional host assets, six public skills, and five public MCP tools. It requires Node.js 20 or later.

## Install the CLI

```bash
npm install -g oh-my-second-brain
oms --help
```

The package exposes both `oms` and `oh-my-second-brain` command names.

## Install host integrations

Install the desired host surfaces and register the MCP server for a specific vault:

```bash
oms install --runtime all --vault /path/to/vault --yes
```

Use `claude`, `codex`, or `hermes` instead of `all` to install one runtime. Host integration is optional; CLI lifecycle and vault operations remain available without it.

Installation writes host-native guidance and skill assets, then stamps the host MCP registration as:

```text
oms mcp --vault /path/to/vault
```

This is an installation detail, not a target-resolution rule. Installing or uninstalling a host does not alter runtime precedence.

## Target resolution

At runtime, target resolution is ordered as follows:

1. Explicit `--vault`.
2. Local `.oms` template controls.
3. Local bridge.
4. `OMS_VAULT`.
5. Current working directory.

The current-directory fallback is read-only for mutation purposes. See [verified targets](./verified-target.md) for admission behavior. The host's stamped `--vault` simply supplies the first, explicit source.

## Template setup

Run setup inside a vault workflow to discover existing templates recursively and review the migration:

```bash
oms setup --vault /path/to/vault --dry-run
```

Apply only with the exact digest reported by that dry run:

```bash
oms setup --vault /path/to/vault --approved-digest <digest>
```

Setup never modifies notes and has no bundled defaults. `.obsidian/types.json` remains read-only; `.oms/template-policy.json` holds semantics, naming, and defaults; `.oms/types.json` is derived and must not be hand-edited.

## Skills and MCP tools

The installable skill set is `write`, `search`, `link`, `distill`, `status`, and `doctor`. Skills are host workflows, not MCP tool names.

`oms mcp` exposes exactly five public tools:

`oms_write` · `oms_search` · `oms_link` · `oms_status` · `oms_doctor`

`oms_status` is read-only. `oms_doctor` diagnoses state and performs supported regenerate/backfill repairs only after verified-target admission. Notes are written through resolved templates in `create`, `append`, or `update` mode.

## Uninstall

```bash
oms uninstall --runtime all --yes
```

Uninstall removes OMS host registrations and installed host assets. It does not modify vault notes, templates, or vault convention files.
