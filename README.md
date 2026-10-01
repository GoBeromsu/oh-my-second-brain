<p align="center">
  <img src="./assets/readme-hero.webp" alt="Abstract 3D artwork of connected notes." width="100%" />
</p>

<h1 align="center">Oh My Second Brain</h1>

<p align="center">
  <strong>A constellation of knowledge, still yours.</strong><br />
  A user-owned knowledge and convention layer for Obsidian, Markdown, and AI agents.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="https://github.com/Xia-Ataraxia/oh-my-second-brain/releases">Releases</a> ·
  <a href="https://github.com/Xia-Ataraxia/oh-my-second-brain/blob/main/README.ko.md">한국어</a>
</p>

<p align="center"><sub>Node.js ≥ 20 · 4 MCP tools · 6 shared skills · Package licensed MIT</sub></p>

Your vault already holds ideas, decisions, and things you learned. **OMS helps your agents find that knowledge and write within the conventions you defined.** Obsidian stays the command center. Your notes stay plain Markdown, readable and editable even when OMS is not running.

## Why OMS?

| Recall | Write with context | Keep ownership |
| :--- | :--- | :--- |
| Start with lexical retrieval. Choose vector, HyDE, query expansion, or reranking when you need them. | Define what your folders and properties mean. Supported write paths check the contract and report their findings. | Keep your existing notes and templates. Connect Claude Code, Codex, and Hermes to the same vault. |

Search and `oms doctor status` stay read-only. Index maintenance is explicit.

## Quick start

**Requires Node.js 20 or later and an existing Obsidian or Markdown vault.** Replace `/path/to/vault` with your vault's absolute path.

### 1. Install

```bash
npm install -g oh-my-second-brain
oms --help
```

### 2. Define your vault's conventions

Run setup in your terminal. The interview covers folders and properties, then seals the contract. Existing notes are not modified.

```bash
oms setup --vault /path/to/vault
oms setup status --vault /path/to/vault
```

### 3. Connect your agent

Install the integration for the host you use:

```bash
oms setup host install --runtime claude --vault /path/to/vault --yes
```

Replace `claude` with `codex` or `hermes`; use `all` to install all three. For Claude Code, add `--execute` to let OMS add the plugin marketplace and run `claude plugin install oms@oh-my-second-brain`, which brings the `/oms:*` skills; without it, OMS prints the exact commands for you to run. Host integration is optional if you only need the CLI. See the [installation guide](./docs/install.md) for Hermes profiles, model setup, and removal.

### 4. Put your knowledge to work

```bash
# Build the derived search index explicitly.
oms doctor sync-embeddings --mode sync --vault /path/to/vault

# Start with lexical search. No vector model required.
oms search "project decisions" --vault /path/to/vault
```

**Try asking your connected agent:**

> Find my notes about this project and surface the decisions I have already made.

> Check this note against my vault contract and show me what needs attention.

> Suggest related notes I could link to, without changing any files.

These are example requests, not captured run results. Available workflows and write enforcement differ by host as described below.

## How it works

**You define the meaning. Your agent writes the content. OMS checks the structure.**

| Layer | What belongs there |
| :--- | :--- |
| **Your vault** | Your Markdown notes, folders, properties, and original templates. Obsidian remains the command center. |
| **Your contract** | The conventions confirmed through `oms setup`, sealed outside the vault under `~/.oms/vaults/<vault-id>/`. |
| **OMS** | Retrieval, contract judgment on supported writes, link inspection, and explicit index maintenance. |
| **Your agent** | Reads context, composes notes, and uses the appropriate host workflow. You and the agent decide what is worth keeping. |

> [!IMPORTANT]
> **Set up the contract before relying on write checks.** A vault with no seal on this machine is not contract-judged: its writes carry a `contract-open` warning naming `oms interview`, and general path and input safeguards still apply. A write that breaks the contract is saved with warnings; a safety refusal, a missing or stale `ifMatch`, or an unverified target leaves the file unchanged. An allowed write with no warnings means structural compliance, not factual accuracy or quality approval.

<details>
<summary><strong>The vault contract, in detail</strong></summary>

- **Meaning is user-owned.** The interview covers folders and the property pool together. OMS hardcodes no property names, folders, or personas and has no Inbox fallback.
- **One control file inside the vault.** `.oms/settings.json` holds `version`, `vaultId`, `templateFolder`, `embedding`, and `agentRepair`. Other `.oms/` entries are ignored and reported as unexpected control files by `oms doctor contract`. `.obsidian/types.json` is a read-only observation, not an override of the seal.
- **Templates stay yours.** Templates live in your `templateFolder` and are never sealed or judged. A new note is scaffolded from the live template: the one the write names, or else the one template whose basename or `folder:` key matches the target folder. OMS never rewrites or copies a template file, and does not parse or execute Templater, JavaScript, or a private token language. A write only fills what is mechanical in the note being written: `{{title}}`, `{{date}}` and `{{time}}` variables, date and datetime defaults on a new note, and the chosen template's frontmatter defaults and missing headings. The note's own values win. It never invents a required value; only a value the contract fixes is filled, as a lossless fix listed in the receipt's `fixes`.
- **Old seals stay readable.** A new seal stores folders and properties only. A seal made by an older release still loads; `oms setup status` counts its template constraints as `legacyTemplates`, and they are reported, never enforced.
- **One judge, bounded feedback.** A saved write returns its contract findings as `{field, kind}` warnings, and a refused write returns its reason the same way. Each of these comes with one guidance command, never rule values, store paths, or the contract body.
- **A tampered seal blocks writes.** When the vault id in `.oms/settings.json` no longer matches this machine's seal, writes are refused as `contract-tampered`; `oms doctor contract` explains it. Missing or broken seal evidence is `contract-unreadable`: the write is saved with that warning until the owner reseals with `oms interview`. When `oms doctor contract` finds a moved vault or a missing or unreadable index entry, it names `oms doctor contract --fix`, which reindexes without resealing. A machine with no seal is a different case: its vault is not contract-judged.

See [architecture](./docs/architecture.md), [conventions](./docs/conventions.md), and [ADR-007](https://github.com/Xia-Ataraxia/oh-my-second-brain/blob/main/docs/decisions/ADR-007-vault-contract-ontology.md).

</details>

<details>
<summary><strong>Setup, template scaffolds, and recovery</strong></summary>

`oms setup` in a terminal runs the interactive interview and seals the contract. `oms interview` is the same terminal interview on its own command; it requires a terminal and refuses to run under `OMS_NON_INTERACTIVE=1`.

The `setup` skill asks the owner each question via `oms setup --questions` and submits answers with `oms setup --answers <file|->`. This path can seal a first or stricter contract; a loosening reseal stays with the owner's terminal. The MCP `interview` tool continues the interview across calls: `op: questions` is read-only, and `answer`, `confirm`, and `seal` record to the interview log on a verified target. It seals only the proposal the owner confirmed and never reclaims a stale seal lock.

Setup and the interview ask about folders and properties only. `oms setup extract --template <name>` previews what a template in `templateFolder` would scaffold: its source, `folder:` selector, property names, and headings. Editing a template takes effect on the next write without a reseal.

`oms doctor contract` diagnoses seal problems, stale locks, orphaned generations, unexpected control files, and hook transport failures. Its `--fix` only re-indexes a moved or unindexed vault, or rebuilds an unreadable index. Other broken seals are resealed with `oms interview`.

Model lifecycle is separate: `oms setup model install|select|waive|status`.

</details>

## MCP tools & integrations

**One domain kernel, with host-native integrations.**

`write` · `search` · `interview` · `doctor`

| MCP tool | Purpose |
| :--- | :--- |
| `write` | Judge a whole note against the sealed contract and save an allowed write. |
| `search` | Retrieve notes, structured context, or wikilink suggestions without changing the vault. |
| `interview` | Continue the vault interview: list open questions, record answers, and seal only the proposal the owner confirmed. |
| `doctor` | Read-only `status`; diagnose the contract, audit notes, check links, and run explicit index maintenance. |

The six skills are `distill`, `doctor`, `interview`, `search`, `setup`, and `write`.

`distill` and `setup` are tool-less workflows; MCP seals only through `interview` `op: seal` on a proposal the owner confirmed. Detail capabilities use `op` values under the four tools. Tool annotations are per tool: only `search` is marked read-only, because `write` and the `doctor` repairs mutate and `interview` is kept conservative.

| Host | Integration | Write checks |
| :--- | :--- | :--- |
| **Claude Code** | Native plugin assets, skills, and MCP | MCP `write` plus `oms hook pre` for native Write, Edit, MultiEdit, and NotebookEdit. |
| **Codex** | Native plugin assets, guidance, and MCP | MCP `write`; no native write hook. |
| **Hermes** | Profile-scoped skills, guidance, and MCP | MCP `write`; no native write hook. |

> [!NOTE]
> Claude's hook denies a write only on a safety refusal: a control or unsafe path (including access under `~/.oms/`), unsupported input, or a tampered contract. A contract finding allows the write with a warning; a hook that cannot run allows the write and logs a warning. Native file writes in Codex and Hermes do not pass through the OMS judge. This is not a filesystem-wide sandbox.

<details>
<summary><strong>Host maintenance and vault targeting</strong></summary>

Host installation stores a signed maintenance pointer at `${XDG_CONFIG_HOME:-~/.config}/oms/vault.json` and stamps `oms serve mcp --vault /path/to/vault` into managed host entries. Only `oms setup host install|remove|sync|status` use that pointer to maintain integrations.

Runtime target resolution does not read it. Precedence is **explicit target → local vault controls → bridge → `OMS_VAULT` → current directory**. The current-directory fallback is read-only: sealing, note writes, and derived-state repair cannot use it.

`oms setup package update` updates the package only. Run `oms setup host sync` separately to synchronize installed host assets. See [verified targets](./docs/verified-target.md).

</details>

## Search your way

**Lexical by default. Additional retrieval channels by choice.** Search includes notes that fail the contract; a missing or damaged contract does not stop retrieval.

| Capability | How to select it | Requirement |
| :--- | :--- | :--- |
| Lexical search | `oms search <text>` | No vector model required. |
| Vector search | `--vec <text>` | Complete `OMS_EMBEDDING_PROVIDER` / `OMS_EMBEDDING_MODEL` pair. |
| HyDE | `--hyde <text>` | Embedding pair plus `OMS_GENERATE_PROVIDER` / `OMS_GENERATE_MODEL`. |
| Query expansion | `--expand` | Explicit G004 expansion; `--max-queries` accepts 1–32. |
| Reranking | `--rerank` | Complete `OMS_RERANK_PROVIDER` / `OMS_RERANK_MODEL` pair. |

Missing, incomplete, or uninstalled model selections fail loudly rather than silently switching to another capability. These are available retrieval options, not a claim of parity or superiority over another engine.

Use `oms search --context` for structured context and `oms search --path <note>` to read one note exactly. Indexing is explicit: `oms doctor sync-embeddings --mode sync|embed|repair` selects one of three distinct modes. See [the CLI map](./docs/cli-map.md) for all operations.

## CLI reference

`oms` is the short alias of `oh-my-second-brain`, with seven CLI families. 0.19 replaced the 0.18 families; see the [0.19 migration guide](./docs/migration-0.19.md).

```text
oms search <text>                               Search notes; lexical by default
oms search --path|--context|--link              Read one note, gather context, or suggest links
oms interview                                   Interview the vault owner in a terminal and seal
oms write <path>                                Save a note from stdin when the contract allows it
oms setup                                       Seal the contract (--questions/--answers for agents)
oms setup extract|status                        Preview a template scaffold or the contract posture
oms setup host install|remove|sync|status       Manage host assets and MCP registrations
oms setup model install|select|waive|status     Manage local model selection
oms setup package check|update                  Check or update the OMS package
oms setup bridge add|remove|status              Manage repository-to-vault bridges
oms doctor status                               Show read-only vault health
oms doctor contract|audit|link-check            Diagnose the contract, notes, or wikilinks
oms doctor sync-embeddings|cleanup|build-graph  Maintain the derived index and graph
oms serve mcp|http                              Start the MCP or local HTTP server
oms hook pre                                    Judge a Claude write against the contract
```

<details>
<summary><strong>Command behavior and removed commands</strong></summary>

Every recognized command accepts `--help` and `-h`, exits 0, and has no side effects. An unknown command combined with `--help` exits 1. A family removed in 0.19 exits 1 and names its replacement.

`oms doctor audit` reports `{path, field, kind}` entries without rewriting notes. Notes are written as whole content through `oms write <path> < note.md` or MCP `write {path, content, template?, ifMatch?, check?}`; both take the same write pipeline, and `template` optionally names the template in `templateFolder` that scaffolds a new note. Overwriting an existing note needs `ifMatch` (`--if-match`) with its current `sha256:` revision; `check` (`--check`) judges without touching disk. An allowed write returns a receipt with the new revision and updates the keyword index of an existing engine store in the same call, so the note is searchable at once. There is no completion call or reviewer conversation.

`oms doctor cleanup` removes eligible derived state. `oms doctor build-graph` rebuilds the note graph.

Note `create`, `append`, `update`, and `backfill` are retired operations. There is no `link apply`, note renderer, or compatibility path for those retired operations.

</details>

## Documentation

| Start here | Go deeper |
| :--- | :--- |
| [Installation](./docs/install.md): install, setup, models, removal | [Architecture](./docs/architecture.md): authority and domain boundaries |
| [Vault conventions](./docs/conventions.md): settings and sealed contracts | [CLI map](./docs/cli-map.md): command and MCP operation mapping |
| [Host integrations](./docs/adapters.md): Claude Code, Codex, Hermes | [Verified targets](./docs/verified-target.md): safe vault resolution |
| [Releases](https://github.com/Xia-Ataraxia/oh-my-second-brain/releases): published versions | [Changelog](./CHANGELOG.md): what changed and why |

## Contributing & credits

Contributions are welcome. Start with the [contributing guide](https://github.com/Xia-Ataraxia/oh-my-second-brain/blob/main/CONTRIBUTING.md), or [open an issue](https://github.com/Xia-Ataraxia/oh-my-second-brain/issues) with a reproducible problem or a focused proposal.

[ACKNOWLEDGMENTS](./ACKNOWLEDGMENTS.md) records design influences, including [Ouroboros](./ACKNOWLEDGMENTS.md#ouroboros) and [Gajae Code](./ACKNOWLEDGMENTS.md#gajae-code)'s deep-interview. Those credits describe ideas, not a copied runtime or a research result. The hero artwork is a conceptual 3D illustration of connected notes. It is not a product screenshot, host-smoke evidence, or a product-gate result.

---

<p align="center">
  <strong>Your notes stay yours.</strong><br />
  Built by <a href="https://github.com/GoBeromsu">Beomsu Koh</a> · Package licensed MIT
</p>
