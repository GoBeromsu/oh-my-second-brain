# Oh My Second Brain Architecture

> Canonical product architecture lives in [`docs/harness-architecture.md`](./harness-architecture.md).
> This file summarizes the host/runtime posture and current repository reality.

## Posture: Axis Graph Harness Inside the Host

Oh My Second Brain lives *inside* each host agent and operates beneath it. The control direction is:

```
Host agent (Claude Code / Codex / Hermes)
  └── invokes Oh My Second Brain
        └── reads/writes Obsidian vault (plain markdown)
```

This is the opposite of an OS-above orchestrator (e.g., ouroboros in its orchestrator mode), which drives host agents top-down. Oh My Second Brain borrows the installable harness idea — skills, deterministic gates, and eventually MCP state/runtime surfaces — but it is not in charge of the host agent.

Oh My Second Brain's product posture is an **axis graph harness**:

- frontmatter fields are user-owned retrieval axes,
- folders create physical folder-to-concept placement edges,
- wikilinks create explicit user-authored relation edges,
- note bodies are payload loaded after axis/search narrowing,
- capture and retrieval are separate flows over the same ontology contract.

The full terminology lock is in the harness architecture doc. In short: Oh My Second Brain helps the user operate their own knowledge system so notes can be retrieved and reused later; it does not fill the body content for them.

## The 3-Host Handshake: Shared CORE + Host ADAPTERS

All knowledge logic (validation, ontology loading, folder resolution, graph/cache retrieval, and gated capture) is written **once** inside the shared CORE and exposed via the canonical `oh-my-second-brain` CLI (`oms` compatibility alias) plus the shared MCP server. Host differences (manifest schema, skill layout, invocation sigil, convention-file name) are absorbed by per-host ADAPTERS. Adding a fourth host means writing one more adapter, not touching the core.

| | Claude Code | Codex | Hermes |
|---|---|---|---|
| MCP backbone | `.mcp.json` | `.mcp.json` | "any MCP server" |
| Skills sigil | `/skill` | `$skill` | agentskills.io |
| Convention file | `CLAUDE.md` / `AGENTS.md` | `AGENTS.md` | `SOUL.md` + context files |
| Local vault access | yes | yes | yes |

Root plugin manifests and `assets/{claude,codex,hermes}/` ship installable host surfaces. `oh-my-second-brain install` copies host assets, installs Codex/Hermes skills or rules where the host expects them, and writes host MCP registration.

## Flow Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  Host agent                                                      │
│  (Claude Code | Codex | Hermes)                                  │
│                                                                  │
│  host ADAPTER                                                    │
│  ├─ plugin.json / rule+skill bundle / SOUL.md fragment              │
│  └─ shells out to: oh-my-second-brain setup | doctor | lint   │
└───────────────────────────┬──────────────────────────────────────┘
                            │ invokes
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  Oh My Second Brain convention layer  (src/ — TypeScript, Node ≥20)            │
│                                                                  │
│  src/cli/oms.ts          CLI verbs: setup / doctor / semantic   │
│  src/core/ontology/       load concepts/*.yaml + taxonomy.yaml   │
│  src/ontology/active.ts   resolve vault vs bundled ontology      │
│  src/conventions/         validateFrontmatter → ValidationResult │
│  src/mcp/server.ts        stdio MCP: retrieve/semantic/read/capture │
└───────────────────────────┬──────────────────────────────────────┘
                            │ reads bundled static package assets
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  Package-root assets  (not TypeScript source)                    │
│                                                                  │
│  core/ontology/          shipped default ontology copied to vault │
│  assets/skills/          host-agnostic skill text                  │
│  assets/{claude,codex,hermes}/ host-native guidance, hooks, rules │
└───────────────────────────┬──────────────────────────────────────┘
                            │ reads / writes
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  Obsidian vault  (any plain-markdown folder)                     │
│                                                                  │
│  vault/.oms/                                                    │
│  ├─ taxonomy.yaml          folder ↔ concept + per-folder intent  │
│  └─ ontology/concepts/     user-owned concept YAML files         │
│                                                                  │
│  vault/references/note.md                                        │
│  vault/notes/idea.md       ... any existing folder layout        │
└──────────────────────────────────────────────────────────────────┘
```

## MCP Backbone — Current Boundary and Roadmap

MCP is the shared cross-host transport for retrieve, graph/status, validation, cache, and gated write operations. In the current repository, `src/mcp/server.ts` starts a real stdio MCP server through `oh-my-second-brain mcp` (or `oms mcp`).

The correct runtime framing is:

1. **Now**: CLI setup/doctor and convention engine are real; Claude Code skills exist as installable/guided surfaces.
2. **Next**: install shell can print exact dry-run Claude plugin and MCP registration commands (`oh-my-second-brain setup --install-claude`) without claiming a live runtime.
3. **Now in Phase 2**: real stdio MCP read/status tools are available through `oms mcp`.
4. **Now in Phase 3**: derived graph/search cache tools are available for axis-first retrieval, live context retrieval, native OMS semantic-index sync, semantic document rehydration, and lazy body load.
5. **Now in Phase 4**: the `write` tool is available after path-safety and vault-confinement tests.

## Retrieval View Compatibility

Existing concept YAML may use `lenses`. Keep that key backward-compatible, but explain it to users as a **retrieval view**: an output shape applied after axis graph narrowing and optional search. A retrieval view is not the graph itself.

## Stack

- **TypeScript** (`module: NodeNext`, Node ≥ 20) — runtime for the CLI, convention engine, and adapter interfaces.
- **Markdown** — conventions, skills, agents, and adapter documentation.
- **YAML** — ontology data files (`concepts/*.yaml`, `taxonomy.yaml`); parsed by the `yaml` npm package. Runtime dependencies are tracked in `package.json`.
- **No Obsidian app dependency** — a vault is just a folder of markdown files. Oh My Second Brain reads and writes it directly via the filesystem.
- **No new heavy dependencies** — any additional dep requires explicit approval (spec constraint).
