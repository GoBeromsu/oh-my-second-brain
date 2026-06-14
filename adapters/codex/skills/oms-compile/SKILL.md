---
name: oms-compile
description: Stateless per-concept compile worker — synthesizes a concept wiki page from source materials with SHA-incremental skip, provenance weighting, and cascade backlinks.
---

# oms-compile

Thin pointer to `core/skills/compile`. Runs two strict phases:

1. **Phase A** — load and grade source materials (pure read, no vault mutation). Resolve backlinks from the compile graph.
2. **Phase B** — write synthesized `body` to `processed/` tier only; never to `wiki/` directly.

Check `wasSkipped(result)` before Phase B — skip if material SHA is unchanged.
Pass `result.affected_backlinks` to the M3 wiki collection owner to mark stale pages.
Provenance order: authored > curated > external-raw.
Delete `{dotLlmwiki}/sha-cache.json` to force a full recompile of all concepts.

NOTE: Wiki mirror deferred — depends on M3.
