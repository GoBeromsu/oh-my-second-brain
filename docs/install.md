# Installation

Oh My Second Brain is an npm package with an independent CLI, optional host assets, seven public skills, and five public MCP tools. It requires Node.js 20 or later.

## Install the CLI

```bash
npm install -g oh-my-second-brain
oms --help
```

The package exposes both `oms` and `oh-my-second-brain` command names.

## Install host integrations

Install host surfaces and register the MCP server for a specific vault:

```bash
oms install --runtime all --vault /path/to/vault --yes
```

Use `claude`, `codex`, or `hermes` instead of `all` to install one runtime. Host integration is optional; CLI lifecycle and vault operations remain available without it.

Installation writes host-native guidance and skill assets, then stamps the host MCP registration as:

```text
oms mcp --vault /path/to/vault
```

It also writes a strict signed host-maintenance pointer at
`${XDG_CONFIG_HOME:-~/.config}/oms/vault.json`. Only `install`, `update`,
`reconcile`, and `uninstall` read this record. Reinstalling or explicitly
reconciling another vault uses compare-and-swap and updates every owned host
stamp; uninstall removes the pointer last after host cleanup succeeds.

This is an installation detail, not a target-resolution rule. Installing or uninstalling a host does not alter runtime precedence.

### Hermes roots and provenance

Each Hermes command operates on exactly one root. With `OMS_HERMES_HOME` unset,
that root is `~/.hermes` (for example, Sari). To install for a named Hermes
profile such as Xia, run the command separately with that profile directory:

```bash
OMS_HERMES_HOME=~/.hermes/profiles/xia oms install --runtime hermes --vault /path/to/vault --yes
```

This does not enumerate or modify other profiles; a `hermes -p xia` wrapper
uses the same profile root. Hermes stores npm installation provenance at
`adapters/oms/oms-provenance.json`, outside the skill scan tree. Reinstall
does nothing when the package version and installed skill digest match. A
foreign, incomplete, or tampered install is refused rather than overwritten;
remove or migrate that installation before retrying. A newer recorded npm
version is also refused until an explicit downgrade policy exists; uninstall
remains available for a verified owned installation.

## Target resolution

At runtime, target resolution is ordered as follows:

1. Explicit `--vault`.
2. Local `.oms` template controls.
3. Local bridge.
4. `OMS_VAULT`.
5. Current working directory.

The current-directory fallback is read-only for mutation purposes. See [verified targets](./verified-target.md) for admission behavior. The host's stamped `--vault` simply supplies the first, explicit source; runtime target resolution never reads the maintenance pointer.

## Template setup

Run setup to discover existing templates recursively and review migration:

```bash
oms setup --vault /path/to/vault --dry-run
```

Apply only with the exact digest reported by that dry run:

```bash
oms setup --vault /path/to/vault --yes --approved-digest <digest>
```

Setup never modifies notes and has no bundled defaults. `.obsidian/types.json` remains read-only; `.oms/template-policy.json` holds semantics, naming, and defaults; `.oms/types.json` is derived and must not be hand-edited.

Choose model acquisition during setup with exactly one of these flags:

- `--models-default`: acquire and verify the pinned local model.
- `--models-descriptor <path>`: acquire and SHA-256-verify the operator-supplied descriptor.
- `--models-no-default`: acquire no model; lexical search remains available.

These are local verified acquisitions, not runtime downloads. Direct capability
configuration requires complete pairs: vector search uses
`OMS_EMBEDDING_PROVIDER` with `OMS_EMBEDDING_MODEL`; HyDE also uses
`OMS_GENERATE_PROVIDER` with `OMS_GENERATE_MODEL`; reranking uses
`OMS_RERANK_PROVIDER` with `OMS_RERANK_MODEL`. An incomplete or unavailable
pair fails loudly.

## Search, index, and documents

```text
oms search <text> [--vec <text>] [--hyde <text>] [--expand] [--max-queries <1..32>] [--rerank]
oms embed
oms index sync|status|repair|cleanup|collections|contexts
oms doc get|multi-get
oms serve
```

A plain `oms search <text>` is lexical-only. Every non-lexical channel is
explicit: `--vec`, `--hyde`, G004 `--expand`, and `--rerank`. G004 expansion is
available only when selected; no replacement, parity, or outperformance claim
is made.

`oms embed` is the sole embedding command, and `oms index` has no
embedding subcommand.

When `oms index status` reports a corrupt or incompatible legacy store, inspect
the non-mutating plan with `oms index repair --mode rebuild --dry-run`, then run
`oms index repair --mode rebuild` and `oms index sync`. `--mode drop` only moves
the store to a timestamped backup; it does not create a replacement.

## Skills and MCP tools

The installable skill set is `write`, `search`, `link`, `distill`, `status`, `doctor`, and tool-less `template`. Skills are host workflows, not MCP tool names.

`oms mcp` exposes exactly five public tools:

`oms_write` · `oms_search` · `oms_link` · `oms_status` · `oms_doctor`

`oms_status` is read-only. `oms_doctor` diagnoses state and performs supported regenerate/backfill repairs only after verified-target admission. Notes are written through resolved templates in `create`, `append`, or `update` mode.

## Uninstall

```bash
oms uninstall --runtime all --yes
```

Uninstall removes OMS host registrations and installed host assets. It does not modify vault notes, templates, or vault convention files.

For Hermes, uninstall removes only an installation with valid OMS npm
provenance (or the exact legacy seven-skill layout). It refuses to delete a
foreign or tampered skill tree.
