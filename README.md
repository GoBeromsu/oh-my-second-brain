# Oh My Second Brain

> A host-agnostic, user-owned convention layer for Obsidian and plain-markdown knowledge vaults.

**English** · [한국어](./README.ko.md)

[![npm](https://img.shields.io/npm/v/oh-my-second-brain)](https://www.npmjs.com/package/oh-my-second-brain)
![license](https://img.shields.io/npm/l/oh-my-second-brain)

Oh My Second Brain (`oms`) turns an existing Obsidian/markdown vault into an agent-readable knowledge base. It loads your vault's own folder/frontmatter conventions, validates notes against them, builds a local link graph, and exposes all of it to AI coding hosts (Claude Code, Codex, Hermes) through a single MCP server — without locking you into any one host or moving your notes.

It is **convention-first and user-owned**: your vault stays plain markdown, the ontology lives in a committed `.oms/` folder you control, and nothing is hidden behind a proprietary store.

## How it works

```
kernel (written once)                     root host surfaces
  ontology + convention logic                .claude-plugin/  Claude plugin manifest
  graph + semantic runtime        +          .codex-plugin/   Codex plugin manifest
  gated note operations                      .mcp.json         Claude MCP registration
  CLI and MCP entry points                   .mcp.codex.json   Codex MCP registration
```

- **kernel** is host-agnostic: ontology, validation, graph/semantic logic, and note operations.
- host-specific assets live at the package root: Claude hooks are in `assets/claude/hooks/`, Codex rules are in `assets/codex/rules/`, and Hermes metadata is `assets/hermes-manifest.json`.
- the cross-host mechanism is one **MCP server** (`oms mcp`) that every host talks to.

## Requirements

- Node.js 20+
- `npm` on `PATH`
- An Obsidian vault, or any folder of markdown notes
- Optional host CLIs: `claude`, `codex`, `hermes`
- Optional embedding backend for [semantic search](#semantic-search-optional)

## Install

One-line (uses the published npm package):

```bash
curl -fsSL https://raw.githubusercontent.com/GoBeromsu/oh-my-second-brain/main/scripts/install.sh | bash
```

Pick hosts and point at a vault:

```bash
curl -fsSL https://raw.githubusercontent.com/GoBeromsu/oh-my-second-brain/main/scripts/install.sh | bash -s -- --runtime all --vault /path/to/vault
```

Or via npm:

```bash
npm install -g oh-my-second-brain
oms install --runtime all --vault /path/to/vault --dry-run   # preview
oms install --runtime all --vault /path/to/vault --yes       # apply
```

Full guide: [docs/install.md](./docs/install.md).

## Hosts

| Host | Manifest | Convention file | Sigil | Status |
|------|----------|-----------------|-------|--------|
| **claude-code** | `.claude-plugin/plugin.json` | `CLAUDE.md` | `/` | installable |
| **codex** | `.codex-plugin/plugin.json` | `AGENTS.md` | `$` | native skills + MCP |
| **hermes** | `assets/hermes-manifest.json` | `SOUL.md` | (MCP/tools) | native skills + MCP |

`oms install` writes the host-native rules/skills and a managed `oms` MCP registration, and is reversible with `oms uninstall`. Per-host details: [docs/install.md](./docs/install.md).

## CLI

```
oms setup      Adopt an existing vault into the convention (writes .oms/taxonomy.yaml; never edits notes)
oms install    Install host assets + MCP registration
oms uninstall  Remove host assets + MCP registration
oms update     Check/apply a package update, then reconcile host assets
oms doctor     Validate note frontmatter against the ontology (aggregated by field & concept)
oms lint       Check vault link health: broken [[wikilinks]] + orphan notes
oms semantic   Native markdown semantic index / search / get
oms mcp        Start the stdio MCP server
oms hook       Vault guard hooks (Claude Code pre/post tool-use)
```

`oh-my-second-brain` is the canonical command; `oms` is the short alias.

## MCP tools

`oms mcp` exposes exactly five public tools:

`oms_write` · `oms_search` · `oms_link` · `oms_status` · `oms_doctor`

`oms_write` is gated by path-safety, vault-confinement, and the kernel-owned concept contract.

## Vault layout (`.oms/`)

`oms setup` adopts your vault into a committed `.oms/` folder with two layers (ADR-006):

- **Contract (machine-validated)** — `taxonomy.yaml` (folder → intent → concept) and `concepts/*.yaml` (per-note-type frontmatter declarations). Enforced by `vault-lint` and `oms_validate_contract`.
- **Governance (human intent)** — `governance/` ADRs and rules; never machine-parsed.
- `.oms/cache/` (derived graph/embedding artifacts) is gitignored.

`setup` writes `.oms/taxonomy.yaml`, preserves existing `.oms/concepts/`, and never modifies your notes.

## Semantic search (optional)

Semantic retrieval requires a real embedding model — there is no fake/hash fallback (ADR-007). Configure embeddings explicitly with `OMS_EMBEDDING_PROVIDER` + `OMS_EMBEDDING_MODEL` (`gguf` with a local GGUF model path, or `upstage` with a model id and `UPSTAGE_API_KEY`), then sync and query:

```bash
oms semantic sync  --vault /path/to/vault --collection vault
oms semantic query "what should I retrieve?" --vault /path/to/vault
```

Without a configured model, graph-based retrieval and convention validation still work.

## Development

```bash
npm install
npm run build
npm test
npm run release:check   # lint + build + test + audit + pack + artifact-smoke + plugin validate
```

Release process: [docs/release.md](./docs/release.md).

## License

MIT. See [ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md) for upstream credits.
