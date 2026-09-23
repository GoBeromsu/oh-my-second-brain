# Installation

Oh My Second Brain is an npm package with an independent CLI, optional host assets, eight public skills, and five public MCP tools. It requires Node.js 20 or later.

## Install the CLI

```bash
npm install -g oh-my-second-brain
oms --help
```

The package exposes both `oms` and `oh-my-second-brain` command names.

## Install host integrations

Host installation is optional. The user authorizes it by running the command below; package update and server startup do not install a host. CLI lifecycle and vault operations remain available without a host.

```bash
oms host install --runtime all --vault /path/to/vault --yes
```

Use `claude`, `codex`, or `hermes` instead of `all` to install one runtime.

Installation writes host-native guidance and skill assets, then stamps the host MCP registration as:

```text
oms serve mcp --vault /path/to/vault
```

Codex installation also copies the optional owned role `~/.codex/agents/oms-reviewer.toml` and its provenance sidecar. That file is not required. A generic separate Codex reviewer remains valid when the custom role is absent. See [host assets](./adapters.md) for what a definition file does and does not prove.

It also writes a strict signed host-maintenance pointer at `${XDG_CONFIG_HOME:-~/.config}/oms/vault.json`. Only `host install`, `host sync`, and `host remove` use this record. Installing or explicitly syncing another vault uses compare-and-swap and updates every owned host stamp; removal deletes the pointer last after host cleanup succeeds.

This is an installation detail, not a target-resolution rule. Installing or uninstalling a host does not alter runtime precedence.

### Hermes roots and provenance

Each Hermes command operates on exactly one root. With `OMS_HERMES_HOME` unset, that root is `~/.hermes`. To install for a named Hermes profile, run the command separately with that profile directory:

```bash
OMS_HERMES_HOME=~/.hermes/profiles/research oms host install --runtime hermes --vault /path/to/vault --yes
```

This does not enumerate or modify other profiles; a `hermes -p research` wrapper uses the same profile root. Hermes stores npm installation provenance at `adapters/oms/oms-provenance.json`, outside the skill scan tree. Reinstall does nothing when the package version and installed skill digest match. A foreign, incomplete, or tampered install is refused rather than overwritten; remove or migrate that installation before retrying. A newer recorded npm version is also refused until an explicit downgrade policy exists; uninstall remains available for a verified owned installation.

## Target resolution

At runtime, target resolution is ordered as follows:

1. Explicit `--vault`.
2. Local `.oms` template controls.
3. Local bridge.
4. `OMS_VAULT`.
5. Current working directory.

The current-directory fallback is read-only. OMS does not write ordinary notes on any source. See [verified targets](./verified-target.md). The host's stamped `--vault` supplies the explicit source; runtime target resolution never reads the maintenance pointer.

## Contract setup

`.oms/template-policy.json` version 4 is the only approved structure and meaning authority. Version 3 is unsupported and is not converted automatically. The default layer is always on and starts empty. An individual template only adds constraints. A note with no individual template is valid under that default.

Setup proposes that empty v4 policy and publishes it only through the config interview, after the user approves the exact digest. It never modifies notes and it ships no bundled note-type defaults. Model lifecycle stays on `oms model install|select|waive|status`, not on setup-era model flags.

Inspect the proposal, then authorize publication with the digest that proposal showed:

```bash
oms setup --vault /path/to/vault --dry-run
oms setup --vault /path/to/vault --yes --approved-digest <digest>
```

Choose model lifecycle explicitly after setup:

- `oms model install`: acquire and verify a model.
- `oms model select`: select an installed model.
- `oms model waive`: explicitly use no model; lexical search remains available.
- `oms model status`: inspect model state without mutation.

These are local verified acquisitions, not runtime downloads. Direct capability configuration requires complete pairs: vector search uses `OMS_EMBEDDING_PROVIDER` with `OMS_EMBEDDING_MODEL`; HyDE also uses `OMS_GENERATE_PROVIDER` with `OMS_GENERATE_MODEL`; reranking uses `OMS_RERANK_PROVIDER` with `OMS_RERANK_MODEL`. An incomplete or unavailable pair fails loudly.

## Notes, search, index, and serving

```text
oms note guide|check|complete|audit|get
oms template scan|list|show|check|regenerate-types|review|answer|commit
oms link suggest|check
oms search query <text> [--vec <text>] [--hyde <text>] [--expand] [--max-queries <1..32>] [--rerank]
oms search context
oms index sync|embed|repair|status|clean
oms graph build|status
oms serve mcp|http
```

`guide` returns the chosen new or existing note path, approved Markdown, effective contract, and task binding. After the agent saves the file, `check` reads the note, controls, and declared evidence. `complete` re-reads those same inputs against the separate reviewer's structured result. None of the three writes the note. The agent writes and repairs the file. The command table is [the CLI map](./cli-map.md).

`template review`, `answer`, and `commit` are the config interview. `commit` publishes only the approved contract diff, using compare-and-swap. It does not write ordinary notes.

A plain `oms search query <text>` is lexical-only. Every non-lexical channel is explicit: `--vec`, `--hyde`, G004 `--expand`, and `--rerank`. G004 expansion is available only when selected; no replacement, parity, or outperformance claim is made. Read-only search still returns unbound, invalid, and incomplete notes. Policy validity does not gate it.

`oms index sync`, `oms index embed`, and `oms index repair` are exclusive modes of the same guarded embedding operation; obsolete boolean `embed` and `force` combinations are not accepted. `status` is read-only and selects the `status`, `collections`, or `contexts` view. `clean` removes eligible derived state.

`oms note get` replaces the old document aliases and selects exactly one of a single target, multiple targets, or a note path plus window. `oms link suggest` and `oms link check` inspect wikilinks and do not apply edits. `oms bridge add|remove|status` manages the repository-to-vault bridge and does not invent a repair action.

`oms serve mcp` and `oms serve http` start their respective servers without creating a vault engine store at startup. There is no OMS host launcher.

## Host, package, and model lifecycle

Use `oms host install|remove|sync|status` for host integrations. `oms package check|update` manages the npm package only; package update never performs host sync implicitly. Use `oms model install|select|waive|status` for model lifecycle instead of setup-era model flags. Hook entrypoints are `oms hook pre|post`; post-tool-use records the tool result and is not a graph-build alias. Claude's write hook is fail-open. Codex and Hermes declare no write hook. A hook entrypoint is not a hard save block.

## Skills and MCP tools

The installable skill set is `distill`, `doctor`, `interview`, `link`, `search`, `status`, `template`, and `write`. `interview` and `template` are tool-less. Skills are host workflows, not MCP tool names.

`oms serve mcp` exposes exactly five public tools:

`oms_write` · `oms_search` · `oms_link` · `oms_status` · `oms_doctor`

`oms_status` is read-only and does not stand in for completion. `oms_doctor` diagnoses controls and indexes. Its repairs are explicit managed-state repairs after verified-target admission, not note backfill. Notes are written by the agent.

## Remove host integrations

```bash
oms host remove --runtime all --yes
```

`oms host remove` refuses to run without `--yes` or `--dry-run`, unless `OMS_NON_INTERACTIVE=1`. It deletes the owned host integration: registrations and installed host assets. It does not modify vault notes, templates, or vault convention files.

For Hermes, removal deletes only an installation with valid OMS npm provenance, or an older unrecorded tree that still passes the installer's legacy ownership check. It refuses to delete a foreign or tampered skill tree.

For Codex, the optional `oms-reviewer.toml` is deleted only when OMS owns it. An unowned role file stays in place and does not stop the rest of Codex cleanup.
