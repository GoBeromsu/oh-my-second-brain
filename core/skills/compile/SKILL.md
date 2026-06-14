---
name: compile
version: 0.1.0
description: Stateless per-concept compile worker — takes a concept name, source materials, and graph context; returns a synthesized Markdown page body with SHA-incremental skip, nashsu 2-step CoT, atomicstrata 2-phase separation, lucasastorian cascade backlinks, and provenance-weighted synthesis context.
trigger: /compile
tags: [compile, wiki, synthesis, sha, incremental, second-brain, oms]
---

## compile

Compile a concept page from source materials using the OMS compile engine.

### When to use

Use `compile` when you need to synthesize a concept wiki page from one or more source materials. The worker skips recompile when material SHA is unchanged (incremental by default).

### Inputs

- `concept` — human-readable concept name (used in LLM prompts)
- `materials` — list of `{ path, text, grade }` items (grade resolved from folder->grade map)
- `graph` — compile graph providing `getBacklinks(docPath)` (use `createNullGraph()` when unavailable)
- `llm` — injected LLM provider (use `createDeterministicStub()` for offline/tests)
- `dotLlmwiki` — absolute path to `.llmwiki/` dotfolder (SHA cache location)
- `conceptId` — stable cache key (vault-relative path recommended)

### Output

Returns `CascadeResult`:
- `body` — synthesized Markdown with `[[wikilinks]]` (empty string when SHA unchanged / skipped)
- `sha` — SHA-256 fingerprint of the input materials
- `provenance` — grades of contributing materials
- `affected_backlinks` — vault paths of wiki pages that link to this concept (for M3 staleness)

### Recipe

1. Run Phase A (`phaseA`) to load and grade all source materials (pure read, no vault mutation).
2. Call `compile(opts)` with the Phase A materials, graph, llm, and cache path.
3. Check `wasSkipped(result)` — if true, skip downstream processing.
4. If not skipped, run Phase B (`phaseB`) to write the body to `processed/` tier.
5. Pass `result.affected_backlinks` to the wiki collection owner (M3) to mark stale pages.

### Phase constraints

- Phase A and Phase B never overlap in one execution context.
- Phase B writes to `processed/` ONLY — never to `wiki/` directly.
- Promotion from `processed/` to `wiki/` is the M3 collection owner's responsibility.

### Provenance weighting

Materials are sorted authored > curated > external-raw in synthesis context.
Authored materials are labelled `[AUTHORED — preserve individual voice]` in the LLM prompt.

### SHA cache

Cache location: `{dotLlmwiki}/sha-cache.json` (never synced, never committed).
Delete `sha-cache.json` to force full recompile of all concepts.
