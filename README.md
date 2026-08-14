# Oh My Second Brain

> A host-agnostic, user-owned convention layer for Obsidian and plain-markdown knowledge vaults.

**English** · [한국어](./README.ko.md)

[![npm](https://img.shields.io/npm/v/oh-my-second-brain)](https://www.npmjs.com/package/oh-my-second-brain)
![license](https://img.shields.io/npm/l/oh-my-second-brain)

Oh My Second Brain (`oms`) turns an existing Obsidian/markdown vault into an agent-readable knowledge base. It loads your vault's own folder/frontmatter conventions, validates notes against them, builds a local link graph, and exposes all of it to AI coding hosts (Claude Code, Codex, Hermes) through a single MCP server — without locking you into any one host or moving your notes.

It is **convention-first and user-owned**: your vault stays plain markdown, the ontology lives in a committed `.oms/` folder you control, and nothing is hidden behind a proprietary store.

## How it works

```
core (written once)                       adapters (one per host)
  ontology loading                          claude-code  .claude-plugin + CLAUDE.md   /sigil
  convention validation         +           codex        .codex-plugin + AGENTS.md    $sigil
  graph + semantic runtime                  hermes       manifest.json + SOUL.md      (MCP/tools)
  MCP server (capture/retrieve/validate)
```

- **core** is host-agnostic: ontology, validation, the graph/semantic engine, and the MCP server.
- each **adapter** absorbs exactly one host's structural differences (manifest schema, convention file, invocation sigil) — adding a host means adding an adapter directory, not touching core.
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
| **hermes** | `manifest.json` | `SOUL.md` | (MCP/tools) | native skills + MCP |

`oms install` writes the host-native rules/skills and a managed `oms` MCP registration, and is reversible with `oms uninstall`. Per-host details: [adapters/README.md](./adapters/README.md).

## CLI

```
oms setup      Adopt an existing vault into the convention (writes .oms/taxonomy.yaml; never edits notes)
oms install    Install host adapters + MCP registration
oms uninstall  Remove host adapters + MCP registration
oms update     Check/apply a package update, then reconcile adapters
oms doctor     Validate note frontmatter against the ontology (aggregated by field & concept)
oms lint       Check vault link health: broken [[wikilinks]] + orphan notes
oms semantic   Native markdown semantic index / search / get
oms mcp        Start the stdio MCP server
oms hook       Vault guard hooks (Claude Code pre/post tool-use)
```

`oh-my-second-brain` is the canonical command; `oms` is the short alias.

## MCP tools

`oms mcp` exposes status, read, retrieve, validation, and gated capture tools, including:

`oms_graph_status` · `oms_graph_build` · `oms_list_concepts` · `oms_retrieve_context` · `oms_retrieve_by_axis` · `oms_sync_embeddings` · `oms_semantic_query` · `oms_get_document` · `oms_multi_get_documents` · `oms_lazy_load_note` · `oms_validate_contract` · `write` · `oms_capture_prepare` · `oms_capture_commit`

`write` is gated by path-safety, vault-confinement, and the kernel-owned concept contract. `oms_capture_prepare` / `oms_capture_commit` are compatibility aliases.

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
