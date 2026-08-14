---
name: oms-compile
description: Agent-guided concept compile — synthesize a concept wiki page from source materials with incremental skip, provenance weighting, and cascade backlinks.
---

# Skill: oms-compile (Claude Code)

Synthesize a concept wiki page from source materials.

## Invocation

```
/oms-compile
```

## What this skill does

Thin pointer to `core/skills/compile`. There is no `oms compile` CLI.

1. **Phase A** — load and grade materials; resolve backlinks (pure read).
2. Skip rewrite if the material SHA is unchanged.
3. **Phase B** — write the body to `processed/` only.
4. Pass affected backlinks to the wiki skill so those pages can be marked stale.

Provenance order: authored > curated > external-raw.
Use `oms_retrieve_context` or `oms_get_document` to gather source materials.
Delete `{dotLlmwiki}/sha-cache.json` to force a full recompile.
