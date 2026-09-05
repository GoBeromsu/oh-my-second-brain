# Repository Guidelines

Oh My Second Brain is an Obsidian-first, user-owned convention layer: Obsidian is the command center, while the vault remains plain Markdown on disk and readable without Obsidian. It ships a TypeScript runtime plus a set of markdown conventions, and is invoked from inside AI coding environments (Claude Code, Codex, Hermes). Enforcement is driven by the user's own vault configuration in `vault/.oms/`, not by hardcoded rules.

> This file is contributor guidance for the **repository**. The vault-convention SSOT for end users lives in `core/AGENTS.md` and is owned by a separate lane. Do not conflate them, and do not edit `core/AGENTS.md` from here.

## Project Structure

`src/` has exactly five top-level entries. This is enforced, not conventional — `test/architecture/import-boundary.test.ts` fails if a sixth appears.

| Layer | Holds | Changelog |
|---|---|---|
| `src/kernel/` | All domain logic: conventions, ontology, engine, graph, link, capture, search, setup, update, install resolution, harness registry | `CHANGELOG-kernel.md` |
| `src/cli/` | The `oms` command surface | `CHANGELOG-cli.md` |
| `src/mcp/` | MCP server, the five public tools, schemas | `CHANGELOG-mcp.md` |
| `src/vendors/` | Per-host integration: `claude/`, `codex/`, `hermes/` | `CHANGELOG-vendors.md` |
| `src/assets/` | The shared skill-source location contract | `CHANGELOG-assets.md` |

Outside `src/`:

- `assets/skills/` — the seven skills, authored **once**. There are no per-vendor copies.
- `assets/{claude,codex,hermes}/` — host runtime assets (hooks, rules, guidance).
- `.claude-plugin/`, `.codex-plugin/`, `.mcp.json`, `.mcp.codex.json` — vendor plugin manifests at the repository root.
- `core/ontology/` — read-only default schemas. `core/AGENTS.md` — separately-owned vault SSOT.
- `test/architecture/` — the CI gates. `docs/decisions/` — ADRs.

## Architecture

**Kernel-in-library.** The domain kernel is a library; `cli/` and `mcp/` are thin entrypoints over it. Neither owns behavior the other cannot reach.

**Import direction is gated.** `kernel/` may not import `cli/`, `mcp/`, `vendors/` or `assets/`. `assets/` is a leaf and imports none of them. No `vendors/<a>/` may import `vendors/<b>/` — shared vendor code belongs in `kernel/`.

`cli/` and `mcp/` import `kernel/`, with one deliberate exception class: the CLI is the composition root, so it selects host adapters, invokes host hooks, and starts the MCP or HTTP server. Those edges are enumerated with reasons in `CLI_ENTRYPOINT_EXCEPTIONS` in `test/architecture/import-boundary.test.ts`, and the assertion is exact-match — a new forbidden edge fails, and so does a stale exception. Every other path in `cli/` and `mcp/` must resolve into `kernel/`.

**The public surface is three distinct sets, not one.** Seven skills (`write`, `search`, `link`, `distill`, `status`, `doctor`, `template`). Five MCP tools (`write`, `search`, `link`, `status`, `doctor`) are a strict subset. CLI command families are an independent allowlist: `setup`, `template`, `note`, `link`, `bridge`, `search`, `index`, `graph`, `host`, `package`, `model`, `serve`, `hook`, and `status`. Never collapse these into equality; `test/architecture/surface-parity.test.ts` guards it.

**Detail operations are demoted, never deleted.** The 18 former detail tools route through the five public tools by an `op` parameter (`oms_doctor` + `op: "sync-embeddings"`, `oms_search` + `op: "query"`). Adding a capability means adding an `op`, not a sixth tool.

**`status` reads, `doctor` writes.** `status` is read-only health and statistics. The MCP `doctor` tool diagnoses and repairs; CLI diagnosis is placed under the object it checks (`template check`, `note audit`). Every mutating repair op routes through the verified-target write kernel and returns a receipt with a server-verified postcondition; a `cwd`-inferred target rejects repair while still allowing diagnosis.

`oms_search` is annotated read-only. Its search paths resolve an existing read-only engine store or use an in-memory ephemeral core without creating `.oms/`. `oms serve mcp` and `oms serve http` also do not create a vault store merely by starting.
Index creation and embedding synchronization remain `oms_doctor` + `op: "sync-embeddings"` with the exclusive `sync`, `embed`, or `repair` mode.

The complete CLI-to-MCP mapping is maintained in [docs/cli-map.md](./docs/cli-map.md).

**Vendor nativeness differs by host and that is correct.** Claude and Codex read repo-root plugin manifests; Hermes has no such concept and installs into `~/.hermes/skills/`. A uniform mechanism would be the compromise, not the asymmetry.

## Development Commands

```bash
npm run lint    # tsc --noEmit — the ONLY check that catches missing .js extensions
npm run build   # tsc -> dist/
npm test        # vitest
npm run audit
npm run check:docs
```

Run all of them before opening a PR.

## Critical: NodeNext Import Extensions

`moduleResolution` is NodeNext. **Every relative import in `src/**/*.ts` must carry a `.js` extension**, even though the source is `.ts`:

```ts
import { loadOntology } from "./ontology/loader.js";  // correct
import { loadOntology } from "./ontology/loader";     // build fails
```

Vitest resolves the missing extension silently and will pass. Only `npm run lint` reports it. After moving or renaming any file, run lint before trusting a green test run.

Related trap: `tsconfig.json` excludes `**/*.test.ts`, so `npm run lint` does **not** typecheck test files. Type errors there surface only under `npm test`.

## Convention-as-Data

The active convention is user-owned, resolved from `vault/.oms/` at runtime; `core/ontology/` ships read-only defaults. Enforcement is `onViolation: warn` for doctor and audit reporting, while MCP `write` rejects contract violations and leaves disk untouched. Schema policy is `additionalProperties: preserve` — unknown fields are kept, not stripped. Do not change these to blocking without an explicit product decision.

`write` demands a verified target vault, resolved `explicit` > local `.oms` > bridge `links.yaml` > `OMS_VAULT`. A `cwd`-inferred target is read-only and writes are rejected. See [docs/verified-target.md](./docs/verified-target.md).

## Search Backends

`src/kernel/searchbackend/` defines `SearchBackend`; the in-repo engine is the **default** implementation. qmd is pluggable, neither default nor required. A new backend implements the interface and must pass `src/kernel/searchbackend/conformance.test.ts`.

ADR-007 is permanently locked: an unavailable backend fails **loudly** with actionable guidance and never silently degrades. A plain `query` expands to lexical only; requesting `vec` without a configured provider correctly returns `available: false` naming `OMS_EMBEDDING_PROVIDER` and `OMS_EMBEDDING_MODEL`.

## CI Gates

Three gates run per pull request and fail closed. A gate that scans zero files is treated as broken, not passing.

| Gate | Enforces |
|---|---|
| `test/architecture/check-module-size.test.ts` | 2000-line soft cap, 200-line reseed slack, signed `MODULE_SIZE_POLICY_ID` so policy cannot be loosened in the same commit that grows a module |
| `test/architecture/import-boundary.test.ts` | Layer import direction, vendor isolation, and the five-entry terminal state |
| `test/architecture/surface-parity.test.ts` | Skills / tools-subset / CLI-allowlist relationships |

## Contribution Rules

- Keep diffs small, one concern per PR.
- No new dependencies without explicit sign-off in the PR description.
- No `any` without a comment explaining why.
- Every new branch in `src/` needs a vitest case.
- The active convention contract is JSON at `.oms/types.json`; `.obsidian/types.json` is a read-only authority. Legacy YAML is ignored without migration or a deprecation warning; `additionalProperties: preserve` remains in effect.
- Commit user-owned `.oms/template-policy.json`, `.oms/taxonomy.json`, and derived `.oms/types.json` when they define the vault convention. Never commit `.oms/engine-store.sqlite` or runtime event journals; engine state is rebuildable and runtime history lives outside the vault.
- See [CONTRIBUTING.md](./CONTRIBUTING.md) for the source-to-doc mapping table and per-change checklists.

## Git Workflow

- Sync before branching: `git fetch origin && git switch -c <branch> origin/main`. This repo is often developed in detached-HEAD worktrees that lag `main`, and branching off a stale HEAD risks rebuilding on retired code.
- Rebase on `origin/main` if it advances mid-task.
- **Worktree caveat:** when `main` is checked out in another worktree, skip `gh pr merge --delete-branch` — the local branch delete fails with `'main' is already used by worktree`. Merge, then `git push origin --delete <branch>` manually.

## Commit, Changelog, Release

- Every user-facing change adds an entry under `## [Unreleased]` in the **layer file** matching the change, in the same PR. Write prose about what changed and why it matters.
- **Released `## [X.Y.Z]` sections are immutable**, enforced by `scripts/changelog-history-guard.mjs` across all six changelog files. Fix a past release's notes by shipping a patch, never by editing history.
- On a rebase conflict in `[Unreleased]`, keep **both** contributors' entries.
- Release runs on `oms-v*` tags via `.github/workflows/release.yml`, which owns the full `npm run release:check` chain. Per-PR CI deliberately does not run release steps — do not add them back.
- Published versions are immutable. Never `git push --force` a tag or `npm unpublish`; fix forward.
