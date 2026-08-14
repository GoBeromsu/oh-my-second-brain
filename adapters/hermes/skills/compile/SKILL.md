---
name: compile
description: Agent-guided concept compile — synthesize a concept wiki page from source materials with incremental skip, provenance weighting, and cascade backlinks.
---

# oms-compile

Thin pointer to `core/skills/compile`. There is no `oms compile` CLI.

Phase A — load and grade source materials (pure read). Resolve backlinks.
Phase B — write synthesized body to `processed/` only; never to `wiki/`.

Skip Phase B if the material SHA is unchanged. Pass affected backlinks to the wiki skill. Provenance order: authored > curated > external-raw. Delete `{dotLlmwiki}/sha-cache.json` to force a full recompile.
