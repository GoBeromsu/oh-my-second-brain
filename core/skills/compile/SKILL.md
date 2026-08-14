---
name: compile
version: 0.1.0
description: Agent-guided concept compile — synthesize a concept wiki page from source materials with incremental skip, two-phase write separation, cascade backlinks, and provenance-weighted context.
trigger: /compile
tags: [compile, wiki, synthesis, sha, incremental, second-brain, oms]
---

## compile

Synthesize a concept page from source materials. There is no `oms compile` CLI
and no TypeScript compile worker — follow this recipe as the agent.

### When to use

Use `compile` when you need to synthesize a concept wiki page from one or more
source materials. Skip rewrite when the material fingerprint is unchanged.

### Inputs

- `concept` — human-readable concept name (used in prompts)
- `materials` — list of `{ path, text, grade }` items (grade from folder→grade map)
- backlinks — wiki pages that already link to this concept (empty if unknown)
- `conceptId` — stable cache key (vault-relative path recommended)

Gather materials with MCP `oms_retrieve_context` or `oms_get_document`.

### Output

- `body` — synthesized Markdown with `[[wikilinks]]` (empty when skipped)
- `sha` — SHA-256 fingerprint of the input materials
- `provenance` — grades of contributing materials
- `affected_backlinks` — vault paths of wiki pages that link to this concept

### Recipe

1. **Phase A** — load and grade all source materials (pure read, no vault mutation).
2. Fingerprint the materials. If `{dotLlmwiki}/sha-cache.json` already has the
   same SHA for `conceptId`, skip the rest.
3. **Phase B** — write the synthesized body to the `processed/` tier only.
4. Pass `affected_backlinks` to the wiki skill so those pages can be marked stale.

### Phase constraints

- Phase A and Phase B never overlap in one execution context.
- Phase B writes to `processed/` ONLY — never to `wiki/` directly.
- Promotion from `processed/` to `wiki/` is the wiki skill's responsibility.

### Provenance weighting

Materials are sorted authored > curated > external-raw in synthesis context.
Authored materials are labelled `[AUTHORED — preserve individual voice]` in the prompt.

### SHA cache

Cache location: `{dotLlmwiki}/sha-cache.json` (never synced, never committed).
Delete `sha-cache.json` to force full recompile of all concepts.
