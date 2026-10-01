# Installation

Oh My Second Brain is an npm package with an independent CLI, optional host assets, six public skills, and four public MCP tools. It requires Node.js 20 or later.

## Install the CLI

```bash
npm install -g oh-my-second-brain
oms --help
```

The package exposes both `oms` and `oh-my-second-brain` command names.

## Install host integrations

Host installation is optional. The user authorizes it by running the command below; package update and server startup do not install a host. CLI lifecycle and vault operations remain available without a host.

```bash
oms setup host install --runtime all --vault /path/to/vault --yes
```

Use `claude`, `codex`, or `hermes` instead of `all` to install one runtime.

The Claude skills ship in the `oms@oh-my-second-brain` plugin. Add `--execute` to let OMS add the marketplace from the installed package and run `claude plugin install oms@oh-my-second-brain` through the Claude CLI; if either step fails, it falls back to `claude plugin install <package path>`, which installs the plugin under a local id. Without `--execute` (or with `--dry-run`), OMS prints the exact commands for you to run. If an earlier version installed `oms@oms`, remove it first with `claude plugin uninstall oms@oms` and `claude plugin marketplace remove oms`.

Installation writes host-native guidance and skill assets, then stamps the host MCP registration as:

```text
oms serve mcp --vault /path/to/vault
```

It also writes a strict signed host-maintenance pointer at `${XDG_CONFIG_HOME:-~/.config}/oms/vault.json`. Only `host install`, `host sync`, and `host remove` use this record. Installing or explicitly syncing another vault uses compare-and-swap and updates every owned host stamp; removal deletes the pointer last after host cleanup succeeds.

This is an installation detail, not a target-resolution rule. Installing or uninstalling a host does not alter runtime precedence.

### Hermes roots and provenance

Each Hermes command operates on exactly one root. With `OMS_HERMES_HOME` unset, that root is `~/.hermes`. To install for a named Hermes profile, run the command separately with that profile directory:

```bash
OMS_HERMES_HOME=~/.hermes/profiles/research oms setup host install --runtime hermes --vault /path/to/vault --yes
```

This does not enumerate or modify other profiles; a `hermes -p research` wrapper uses the same profile root. Hermes stores npm installation provenance at `adapters/oms/oms-provenance.json`, outside the skill scan tree. Reinstall does nothing when the package version and installed skill digest match. A foreign, incomplete, or tampered install is refused rather than overwritten; remove or migrate that installation before retrying. A newer recorded npm version is also refused until an explicit downgrade policy exists; uninstall remains available for a verified owned installation.

## Target resolution

At runtime, target resolution is ordered as follows:

1. Explicit `--vault`.
2. Local `.oms/settings.json`.
3. Local bridge.
4. `OMS_VAULT`.
5. Current working directory.

The current-directory fallback is read-only: sealing and note writes are refused on it. See [verified targets](./verified-target.md). The host's stamped `--vault` supplies the explicit source; runtime target resolution never reads the maintenance pointer.

## Contract setup

The vault contract is sealed by the user at an interactive terminal:

```bash
oms setup --vault /path/to/vault
oms setup status --vault /path/to/vault
```

`oms setup` interviews folders, the property pool, and the templates in the template folder together, then seals the contract under `~/.oms/vaults/<vault-id>/`, outside the vault. Inside the vault it writes only `.oms/settings.json`, and it never modifies notes. The interactive interview (`oms setup`, and `oms interview`) refuses to run without a TTY or under `OMS_NON_INTERACTIVE=1`. Through the `setup` skill an agent asks the owner each question and runs `oms setup --questions` / `oms setup --answers <file|->`, which seal a first or stricter contract only; loosening stays with the terminal. Run it again at any time to re-seal. `oms doctor contract` diagnoses the seal; see [conventions](./conventions.md).

Model lifecycle is separate from sealing:

- `oms setup model install`: acquire and verify a model.
- `oms setup model select`: select an installed model.
- `oms setup model waive`: explicitly use no model; lexical search remains available.
- `oms setup model status`: inspect model state without mutation.

These are local verified acquisitions, not runtime downloads. Direct capability configuration requires complete pairs: vector search uses `OMS_EMBEDDING_PROVIDER` with `OMS_EMBEDDING_MODEL`; HyDE also uses `OMS_GENERATE_PROVIDER` with `OMS_GENERATE_MODEL`; reranking uses `OMS_RERANK_PROVIDER` with `OMS_RERANK_MODEL`. An incomplete or unavailable pair fails loudly.

## Notes, search, index, and serving

```text
oms search <text> [--vec <text>] [--hyde <text>] [--expand] [--max-queries <1..32>] [--rerank]
oms search --path|--context|--link
oms write <path>
oms interview
oms doctor status|contract|audit|link-check
oms doctor sync-embeddings|cleanup|build-graph
oms serve mcp|http
```

The agent writes notes, through MCP `write {path, content, template?, ifMatch?, check?}`, `oms write <path>` with the note on stdin, or, in Claude Code, through native tools judged by the guard hook. A write that breaks the sealed contract is saved with warnings; a safety refusal, a missing or stale `ifMatch`, or an unverified target leaves the file unchanged. `oms doctor audit` judges existing notes and reports `{path, field, kind}` entries without rewriting them. There is no completion command or reviewer handshake; the agent and user decide whether a note is worth keeping. The command table is [the CLI map](./cli-map.md), and the 0.18 spellings are mapped in [the migration guide](./migration-0.19.md).

A plain `oms search <text>` is lexical-only. Every non-lexical channel is explicit: `--vec`, `--hyde`, G004 `--expand`, and `--rerank`. G004 expansion is available only when selected; no replacement, parity, or outperformance claim is made. Search still returns notes that would fail the contract, and a missing or damaged contract does not stop it.

`oms doctor sync-embeddings --mode sync|embed|repair` selects exclusive modes of the same guarded embedding operation; obsolete boolean `embed` and `force` combinations are not accepted. `oms doctor status` is read-only. `oms doctor cleanup` removes eligible derived state.

`oms search --path <note>` reads exactly one note without the index. `oms search --link <note>` suggests wikilinks and `oms doctor link-check` reports broken ones; neither applies edits. `oms setup bridge add|remove|status` manages the repository-to-vault bridge and does not invent a repair action.

`oms serve mcp` and `oms serve http` start their respective servers without creating a vault engine store at startup. There is no OMS host launcher.

## Host, package, and model lifecycle

Use `oms setup host install|remove|sync|status` for host integrations. `oms setup package check|update` manages the npm package only; package update never performs host sync implicitly. Use `oms setup model install|select|waive|status` for model lifecycle. The hook entrypoint is `oms hook pre`; there is no post-tool-use hook. Claude's write hook denies a write only on a safety refusal; a contract finding, or a hook that cannot run, allows the write with a warning. Codex and Hermes declare no write hook.

## Skills and MCP tools

The installable skill set is `distill`, `doctor`, `interview`, `search`, `setup`, and `write`. `distill` and `setup` are tool-less. Skills are host workflows, not MCP tool names.

`oms serve mcp` exposes exactly four public tools:

`oms_write` · `oms_search` · `oms_interview` · `oms_doctor`

Only `oms_search` is annotated read-only. `oms_interview` lists interview questions read-only by default; its `answer`, `confirm`, and `seal` ops need a verified target and seal only a confirmed proposal. `oms_doctor` diagnoses the contract and indexes, and `op: status` is its read-only health view. Its repairs are explicit managed-state repairs after verified-target admission, not note backfill. Notes are written by the agent.

## Remove host integrations

```bash
oms setup host remove --runtime all --yes
```

`oms setup host remove` refuses to run without `--yes` or `--dry-run`, unless `OMS_NON_INTERACTIVE=1`. It deletes the owned host integration: registrations and installed host assets. It does not modify vault notes, templates, `.oms/settings.json`, or the sealed contract.

For Hermes, removal deletes only an installation with valid OMS npm provenance, or an older unrecorded tree that still passes the installer's legacy ownership check. It refuses to delete a foreign or tampered skill tree.

OMS no longer installs a Codex reviewer role. Removal still deletes `~/.codex/agents/oms-reviewer.toml` and its provenance sidecar left by an earlier version, and only when the OMS-written provenance record proves ownership. An unowned role file stays in place and does not stop the rest of Codex cleanup.
