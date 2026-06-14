# wiki — M3 Wiki Collection Owner + Staleness Ledger

This sub-module implements Milestone 3 of the oh-my-secondbrain engine.
It is the **only** code allowed to write into `wiki/`; compile (M2) never touches `wiki/` directly.

## Module layout

| File | Responsibility |
|------|---------------|
| `types.ts` | Wiki-local types: `StalenessState` FSM, `LedgerEntry`, `LintFinding`, `NowFn` |
| `ledger.ts` | 5-state staleness FSM persisted to `.llmwiki/staleness.json` |
| `navigation.ts` | Karpathy navigation surfaces: `wiki/index.md` catalog + `wiki/log.md` append-only log |
| `collection.ts` | Collection owner: namespace, link-graph closure, ledger delegation, navigation delegation, processed→wiki promotion |
| `lint.ts` | Astro-Han 2-tier lint: auto-fix (index, links, See-Also) + report-only (conflicts, orphans, outdated) |
| `wiki.test.ts` | Co-located vitest suite — 42 tests, no network |

## Staleness FSM

```
         SHA change
 ┌──────────────────────────────────┐
 │                                  ▼
 │  compile output        ┌───────────────┐
 │ ──────────────────────▶│    CLEAN      │
 │                        └───────────────┘
 │                                  │  cascade flip
 │                                  ▼
 │                        ┌───────────────┐
 └────────────────────────│    DIRTY      │◀─ delete staleness.json
                          └───────────────┘
                                    (separate transitions)
 STUB     — referenced by wikilinks but no compile output exists
 ORPHAN   — no incoming wikilinks from any other wiki page
 CONFLICT — two compile sources produced conflicting content
```

Full-rebuild escape hatch: delete `.llmwiki/staleness.json` → every known page resets to DIRTY on the next ledger load.

## 3-phase hard separation (nvk)

```
Research (M1) → Compile (M2, sequential) → Wiki (read-only query surface)
```

- A wiki **query** NEVER triggers compile.
- Compile NEVER writes `wiki/` directly — `promoteToWiki()` is the sole entry point.
- `wiki/` is a read-only query surface from the perspective of all callers except `collection.ts`.

## Usage

```typescript
import { compile } from "../compile/worker.js";
import { createDeterministicStub } from "../compile/cot.js";
import { runCollection } from "./collection.js";

// 1. M2 compile (caller writes result to processed/)
const result = await compile({ concept, materials, graph, llm, dotLlmwiki, conceptId });

// 2. Phase-B: caller writes body to processedDir
await writeFile(path.join(processedDir, "concept.md"), result.body, "utf8");

// 3. M3 collection run (promotes processed/→wiki/ and updates ledger + navigation)
await runCollection({
  processedDir, wikiDir, dotLlmwiki,
  conceptId, conceptName,
  affectedBacklinks: result.affected_backlinks,
  now: () => new Date().toISOString(),
});
```

## Attribution

See `ACKNOWLEDGMENTS.partial.md` in this directory for absorbed-source details.
