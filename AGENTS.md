# AGENTS.md — Oh My Second Brain Contributor Rules

> This file contains **contributor / developer rules** for the Oh My Second Brain repository.
> It is NOT the vault-convention SSOT for end users — that lives in `core/AGENTS.md`
> (owned by a separate lane; do not create or modify it here).

---

## What is Oh My Second Brain?

Oh My Second Brain is a host-agnostic, user-owned convention layer for Obsidian markdown vaults. It ships a
TypeScript runtime and a set of markdown conventions that keep vault notes consistently structured,
linked, and reusable. Oh My Second Brain is invoked from inside AI coding environments (Claude Code, Codex,
Hermes) and enforces — or warns about — frontmatter, naming, and linking rules that the user
defines in their own vault configuration (`vault/.oms/`).

---

## Repo Layout

```
oh-my-second-brain/
├── core/                        # Ontology defaults, skills, agents
│   ├── AGENTS.md                # Vault-convention SSOT for end users (NOT this file)
│   └── ontology/                # Default schemas and rule definitions
├── adapters/
│   ├── claude-code/             # Claude Code adapter
│   ├── codex/                   # OpenAI Codex adapter
│   └── hermes/                  # Hermes adapter
├── src/                         # TypeScript source
│   ├── cli/oms.ts               # CLI entry point
│   ├── ontology/
│   │   ├── loader.ts            # Load vault/.oms/ config + core defaults
│   │   └── resolver.ts          # Merge and resolve final ontology
│   ├── conventions/
│   │   ├── frontmatter.ts       # Frontmatter rule definitions
│   │   └── validate.ts          # Validation engine
│   ├── adapt/                   # Host adapter interfaces
│   └── mcp/                     # MCP server integration
├── docs/                        # User-facing documentation
└── test/                        # Vitest test suite
```

---

## Build and Test Commands

```bash
npm run build   # tsc — compiles src/ to dist/ (NodeNext module resolution)
npm run lint    # tsc --noEmit — type-check only, no output
npm test        # vitest — runs the test suite
```

CI pipeline order: **build first, then test**. A broken build blocks the test run.

---

## Git workflow

- **Sync with mainline before you branch.** Start every task with `git fetch origin && git switch -c <branch> origin/main` (or `git pull --rebase` on a tracking branch). This repo is frequently developed in **detached-HEAD worktrees that lag behind `main`**; branching off a stale HEAD risks rebuilding on retired code (e.g., a module that was deleted on `main`).
- **Rebase on mainline drift.** If `main` advances mid-task, `git rebase origin/main` before opening the PR.
- **Worktree caveat:** when `main` is checked out in another worktree, skip `gh pr merge --delete-branch` — the local branch-delete step fails with `'main' is already used by worktree`. Merge, then delete branches manually (`git push origin --delete <branch>`).

---

## CRITICAL: NodeNext Import Extensions

**tsconfig uses `moduleResolution: NodeNext`.**

Every relative import inside `src/**/*.ts` MUST include a `.js` extension:

```ts
// correct
import { loadOntology } from './ontology/loader.js';

// WRONG — build will fail
import { loadOntology } from './ontology/loader';
```

Vitest resolves imports differently and will NOT catch missing extensions.
Only `npm run build` (tsc) will surface this error. Always run `npm run lint`
after editing imports.

---

## Convention-as-Data

- The active convention is **user-owned**: resolved from `vault/.oms/` at runtime.
- Oh My Second Brain ships read-only **defaults** in `core/ontology/`.
- Enforcement policy: `onViolation: warn` for doctor/audit reporting. MCP `write` rejects contract violations and does not change the disk.
- Schema policy: `additionalProperties: preserve` — unknown fields are kept, not rejected.
- Never change these defaults to blocking/error without an explicit product decision.

---

## Contribution Rules

- **Keep diffs small.** One concern per PR. Prefer targeted edits over broad refactors.
- **No new dependencies without approval.** Runtime dependencies are tracked in
  `package.json` and currently include MCP, SQLite/vector search, local model,
  and YAML packages. Adding any dependency requires explicit sign-off in the PR
  description.
- **No `any` without justification.** Add a comment explaining why if you must use it.
- **Test new logic paths.** Any new branch in `src/` should have a corresponding vitest case.
- **Backward-compatible config changes only.** If a config shape changes, provide a migration path.
- **qmd-compatible interface is a product contract.** CLI/MCP aliases (`query`, `search`, `vsearch`, `get`, `multi-get`/`multi_get`) and `qmd://` resource semantics require ADR-009 review plus adapter parity updates when changed.
- Run `npm run lint && npm run build && npm test` before opening a PR and confirm all pass.

---

## core/AGENTS.md vs. AGENTS.md

| File | Purpose | Owner |
|------|---------|-------|
| `/AGENTS.md` (this file) | Contributor rules for the Oh My Second Brain repo | Dev lane |
| `/core/AGENTS.md` | Vault-convention SSOT for end users | Separate lane |

Do not conflate them. Do not create or modify `core/AGENTS.md` from this lane.
