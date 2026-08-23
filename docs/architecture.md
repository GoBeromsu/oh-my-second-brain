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

## The 3-Host Handshake: Kernel + Root Host Surfaces

Validation, ontology loading, folder resolution, graph and cache retrieval, and gated capture are written **once** in `src/kernel/` and exposed through `src/cli/` and `src/mcp/`. Host differences are represented by root plugin manifests, `assets/`, and `src/vendors/`; they do not require an `adapters/` tree.

**Known gap, stated rather than implied.** Some application workflows still live in the surface layers rather than the kernel: setup's ontology adoption and persistence (`src/cli/setup-command.ts`), linkify's vault scan and batch write orchestration (`src/cli/linkify.ts`), and link discovery and apply (`src/mcp/link-tools.ts`), which duplicates part of the linkify walk. The import-direction gate enforces that `kernel/` does not depend on the surfaces; it does not and cannot enforce where behaviour lives. The practical consequence is that a third transport could not reuse those workflows without importing surface code. Extracting them into kernel services is tracked follow-up work, deliberately not folded into the restructure that established the layout.

| | Claude Code | Codex | Hermes |
|---|---|---|---|
| MCP backbone | `.mcp.json` | `.mcp.codex.json` | "any MCP server" |
| Skills sigil | `/skill` | `$skill` | agentskills.io |
| Convention file | `CLAUDE.md` / `AGENTS.md` | `AGENTS.md` | `SOUL.md` + context files |
| Local vault access | yes | yes | yes |

Root plugin manifests and `assets/` ship installable host surfaces. Claude hooks are in `assets/claude/hooks/`, Codex rules are in `assets/codex/rules/`, and Hermes metadata is `assets/hermes-manifest.json`. The six skills live once in `assets/skills/`: write, search, link, distill, status, and doctor.

## Flow Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  Host agent                                                      │
│  (Claude Code | Codex | Hermes)                                  │
│                                                                  │
│  root host surface                                               │
│  ├─ plugin.json / rule+skill bundle / SOUL.md fragment              │
│  └─ shells out to: oh-my-second-brain setup | doctor | lint   │
└───────────────────────────┬──────────────────────────────────────┘
                            │ invokes
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  Oh My Second Brain convention layer  (src/ — TypeScript, Node ≥20) │
│                                                                  │
│  src/cli/                CLI entry point and commands           │
│  src/kernel/             ontology, conventions, graph, engine   │
│  src/mcp/server.ts       stdio MCP: five public OMS tools        │
│  src/vendors/            per-host installation code             │
│  src/assets/             shared skill-source location contract  │
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
2. **Now**: `oms mcp` exposes exactly `oms_write`, `oms_search`, `oms_link`, `oms_status`, and `oms_doctor`.
3. **Now**: `oms_write` is available after verified-target, path-safety, vault-confinement, and contract checks.

## Retrieval View Compatibility

Existing concept YAML may use `lenses`. Keep that key backward-compatible, but explain it to users as a **retrieval view**: an output shape applied after axis graph narrowing and optional search. A retrieval view is not the graph itself.

## Stack

- **TypeScript** (`module: NodeNext`, Node ≥ 20) — runtime for the CLI, kernel, MCP server, and vendor installation code.
- **Markdown** — conventions, skills, agents, and host guidance.
- **YAML** — ontology data files (`concepts/*.yaml`, `taxonomy.yaml`); parsed by the `yaml` npm package. Runtime dependencies are tracked in `package.json`.
- **No Obsidian app dependency** — a vault is just a folder of markdown files. Oh My Second Brain reads and writes it directly via the filesystem.
- **No new heavy dependencies** — any additional dep requires explicit approval (spec constraint).
