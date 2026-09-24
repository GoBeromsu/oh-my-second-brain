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

`.oms/template-policy.json` version 5 is the only structural authority. It holds the property pool, an always-on common contract with no Markdown file of its own, and explicitly registered templates. A registration inherits the common contract and may add to it, tighten it, or relax it where that relaxation was approved for the template. A note with no individual template is valid under the common contract. Historical version-3 and version-4 policies remain readable; only a mutating selection migrates one in place, preserving its recorded meaning.

Setup connects the vault: it writes the portable `.oms/settings.json` identity and the approved host connection. It publishes no contract and never modifies notes. After the interview agrees the contract document, publish it explicitly with `oms template publish --policy <file.json> --transaction-id <uuid> [--yes]`; publication previews without `--yes` and compares against the exact policy bytes now on disk.

Inspect the connection proposal, then approve the digest and token it showed:

```bash
oms setup --vault /path/to/vault --dry-run
oms setup --vault /path/to/vault --yes --approval-token <token> --approved-digest <digest>
```

Setup can select a model in the same approved pass. Model lifecycle is also available explicitly:

- `oms model install`: acquire and verify a model.
- `oms model select`: select an installed model.
- `oms model waive`: explicitly use no model; lexical search remains available.
- `oms model status`: inspect model state without mutation.

These are local verified acquisitions, not runtime downloads. Direct capability configuration requires complete pairs: vector search uses `OMS_EMBEDDING_PROVIDER` with `OMS_EMBEDDING_MODEL`; HyDE also uses `OMS_GENERATE_PROVIDER` with `OMS_GENERATE_MODEL`; reranking uses `OMS_RERANK_PROVIDER` with `OMS_RERANK_MODEL`. An incomplete or unavailable pair fails loudly.

## Notes, search, index, and serving

```text
oms note guide|check|audit|get
oms template list|show|scan|check|publish|review-sources|acknowledge-source|relink-source
oms link suggest|check
oms search query <text> [--vec <text>] [--hyde <text>] [--expand] [--max-queries <1..32>] [--rerank]
oms search context
oms index sync|embed|repair|status|clean
oms graph build|status
oms serve mcp|http
```

`guide` selects the contract for one explicit note path and returns a session locator. The agent writes the file with its own tools. After the file is saved, `check` reads those saved bytes through that locator and reports declared properties and headings with `semantic: "not-evaluated"`. Neither command writes the note, and there is no completion command or reviewer handshake. The agent and user decide whether the note is worth keeping and repair it. The command table is [the CLI map](./cli-map.md).

`oms template` leaves are `list`, `show`, `scan`, `check`, `publish`, `review-sources`, `acknowledge-source`, and `relink-source`. `publish`, `acknowledge-source`, and `relink-source` require an explicit transaction ID; `review-sources` is read-only. `acknowledge-source` needs the live reviewed digest, and `relink-source` requires a genuinely missing original source plus the exact candidate path supplied by the user. None of these operations writes ordinary notes.

A plain `oms search query <text>` is lexical-only. Every non-lexical channel is explicit: `--vec`, `--hyde`, G004 `--expand`, and `--rerank`. G004 expansion is available only when selected; no replacement, parity, or outperformance claim is made. Read-only search still returns unbound, invalid, and incomplete notes. Policy validity does not gate it.

`oms index sync`, `oms index embed`, and `oms index repair` are exclusive modes of the same guarded embedding operation; obsolete boolean `embed` and `force` combinations are not accepted. `status` is read-only and selects the `status`, `collections`, or `contexts` view. `clean` removes eligible derived state.

`oms note get` replaces the old document aliases and selects exactly one of a single target, multiple targets, or a note path plus window. `oms link suggest` and `oms link check` inspect wikilinks and do not apply edits. `oms bridge add|remove|status` manages the repository-to-vault bridge and does not invent a repair action.

`oms serve mcp` and `oms serve http` start their respective servers without creating a vault engine store at startup. There is no OMS host launcher.

## Host, package, and model lifecycle

Use `oms host install|remove|sync|status` for host integrations. `oms package check|update` manages the npm package only; package update never performs host sync implicitly. Use `oms model install|select|waive|status` for model lifecycle outside setup. Hook entrypoints are `oms hook pre|post`; post-tool-use records the tool result and is not a graph-build alias. Claude's write hook is fail-open. Codex and Hermes declare no write hook. A hook entrypoint is not a hard save block.

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

OMS no longer installs a Codex reviewer role. Removal still deletes `~/.codex/agents/oms-reviewer.toml` and its provenance sidecar left by an earlier version, and only when the OMS-written provenance record proves ownership. An unowned role file stays in place and does not stop the rest of Codex cleanup.
