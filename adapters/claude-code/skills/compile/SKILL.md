---
name: oms-compile
description: Stateless per-concept compile worker — synthesizes a concept wiki page from source materials with SHA-incremental skip, provenance weighting, and cascade backlinks.
---

# Skill: oms-compile (Claude Code)

Synthesize a concept wiki page from source materials using the OMS compile engine.

## Invocation

```
/oms-compile
```

## What this skill does

Conceptually shells out to:

```bash
oms compile <concept>
```

Thin pointer to `core/skills/compile`. The engine runs Phase A (load + grade
materials, pure read) then Phase B (write body to `processed/` tier). Promotion
from `processed/` to `wiki/` is the M3 collection owner's responsibility.

## Agent-guided steps (v0)

1. Identify the **concept** name and locate its source materials.
2. Run **Phase A** — load and grade all materials; resolve backlinks from the compile graph.
3. Call `compile(opts)` with materials, graph, llm, and `dotLlmwiki` cache path.
4. Check `wasSkipped(result)` — if the material SHA is unchanged, skip downstream.
5. Run **Phase B** — write `result.body` to the `processed/` tier only.
6. Pass `result.affected_backlinks` to the wiki collection owner (M3) to mark stale pages.

## Provenance order

Authored > curated > external-raw. Authored materials carry a
`[AUTHORED — preserve individual voice]` label in the LLM prompt.

## Runtime

No MCP tool is required for compile itself — it is a pure TypeScript call.
Use `oms_retrieve_context` or `oms_get_document` to gather source materials
before invoking compile. Delete `{dotLlmwiki}/sha-cache.json` to force a
full recompile of all concepts.

## NOTES

Wiki mirror deferred — the `wiki` skill is built by a parallel milestone (M3)
and its adapter mirror is intentionally deferred until that milestone lands.
