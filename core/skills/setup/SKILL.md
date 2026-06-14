---
name: setup
version: 0.2.0
description: Socratic setup interview — guides the vault owner through exactly 6 binding dimensions (tier-folder mapping, provenance grades, lint-schema SSOT, embedder, ignore glob, agent-writable zone) and writes the result ONLY to vault/.oms/taxonomy.yaml.
trigger: /setup
tags: [setup, interview, socratic, taxonomy, config, oms]
---

# Skill: setup

Adopt an existing Obsidian vault into the Oh My Second Brain convention via a self-contained
Socratic interview. This skill is the engine's OWN config/setup interview — it does NOT import
or depend on the omc deep-interview skill. It self-reimplements the methodology; see CHANGELOG.md
for attribution.

**Non-Sticky Guard (HARD):** Interview output is written ONLY to
`vault/.oms/taxonomy.yaml`. The engine default `core/ontology/taxonomy.yaml` is NEVER modified.

## Methodology

This skill embeds a Socratic clarity loop self-reimplemented from the omc deep-interview
methodology (method only — no code copied; see CHANGELOG.md and ACKNOWLEDGMENTS.partial.md).

### Ambiguity scoring

Each response is scored across four sub-dimensions:

| Sub-dimension | Question |
|---------------|----------|
| Goal | Does this dimension have a clear, testable outcome? |
| Constraint | Are hard limits (paths, protocols, formats) explicit? |
| Criteria | Can we verify completeness or correctness? |
| Context | Is vault-specific context captured (not generic defaults)? |

Score each sub-dimension 0–1 (1 = fully resolved).

```
ambiguity = 1 − mean(goal, constraint, criteria, context)
```

Loop continues while `ambiguity > threshold`. Default threshold: **0.20**.

Threshold is configurable: set `OMS_AMBIGUITY_THRESHOLD=<float>` or pass
`--ambiguity-threshold <float>` at the CLI.

### Round-0 topology gate

Run Round 0 before any dimension interview:

1. List all top-level folders in the vault.
2. Ask the owner to describe the vault's purpose in one sentence.
3. Provisionally map folders to three canonical tiers: `raw`, `processed`, `wiki`.
4. Gate check: if all three tiers cannot be provisionally assigned, stay in Round 0.
   Do not advance to D1–D6 until the topology is clear.

Round 0 has no round limit — it is a prerequisite, not a binding dimension.

### Challenge modes

After each dimension reaches `ambiguity ≤ threshold`, run one challenge pass in sequence:

- **Contrarian**: Argue the opposite mapping. Does the dimension still hold?
- **Simplifier**: Is there a simpler folder/path that achieves the same goal?
- **Ontologist**: Is this dimension naming the right concept, or a surface symptom?

A challenge that raises ambiguity above threshold re-opens the Socratic loop for that
dimension only (up to the per-dimension round limit).

## 6 Binding Dimensions

Exactly these 6 — no more, no less. Each is time-boxed to **≤ 5 exchange rounds**.

### D1 — Tier folder mapping

Map vault top-level folders to the three canonical tiers:

- `raw` — unprocessed captures; nothing required yet
- `processed` — synthesised / reformatted external material
- `wiki` — compiled concept pages (output of `oms compile`)

**Output key:** `folders.<name>.tier` (`raw` | `processed` | `wiki`)

Reference defaults (Ataraxia vault — clearly-labelled example; do NOT pre-fill):
```yaml
# Ataraxia reference only — discover the user's actual mapping
raw: ["Inbox", "Fleeting"]
processed: ["Literature", "Notes"]
wiki: ["Wiki", "Concepts"]
```

### D2 — Provenance grade mapping

Map vault folders to provenance grades used by the compile engine:

- `authored` — written by the vault owner
- `curated` — external sources the owner has read and synthesised
- `external-raw` — raw captures, unverified external material

**Output key:** `folders.<name>.provenance` (`authored` | `curated` | `external-raw`)

Reference defaults (Ataraxia vault — example only; do NOT pre-fill):
```yaml
# Ataraxia reference only
authored: ["Journal", "Essays"]
curated: ["Literature", "Notes"]
external-raw: ["Inbox"]
```

### D3 — Lint schema SSOT location

Identify the single source of truth for the lint schema used by `oms doctor`:

- `engine_default` — use the shipped defaults at `core/ontology/` unchanged
- `vault_override` — the vault extends/overrides via `vault/.oms/concepts/`

Elicit: has the owner customised any concept fields beyond the shipped defaults?

**Output key:** `lint.schema_ssot` (`engine_default` | `vault_override`)

### D4 — Embedder selection

Select the embedding strategy for semantic retrieval:

- `local` — local model (e.g. nomic-embed-text, all-MiniLM-L6-v2)
- `openai` — OpenAI text-embedding-* API
- `stub` — deterministic test stub (no real calls; for CI / offline use)

**Output key:** `embedder.provider` and `embedder.model`

### D5 — ignore_for_external_apis glob

One or more glob patterns identifying notes that MUST NOT be sent to any external API.

Discover from the vault — do NOT pre-fill categories. Prompt the owner to identify:
- Sensitivity categories they care about
- Existing frontmatter fields that signal privacy (e.g. `private: true`)
- Folder naming conventions that imply sensitivity

**Output key:** `ignore_for_external_apis` (array of glob strings)

### D6 — Agent-writable zone + write routing law

Define the paths agents are permitted to write to, and the routing law:

- `agent_writable_zone` — array of vault-relative path prefixes agents may write
- `write_routing_law`:
  - `append_only` — agents may only append; never overwrite existing content
  - `overwrite_allowed` — agents may create or overwrite within the zone
  - `create_only` — agents may only create new files; never modify existing ones

Paths outside `agent_writable_zone` are read-only to all agents.

**Output key:** `agent_writable_zone` (string[]) and `write_routing_law`

## Non-Sticky Guard (HARD)

> Interview output is written ONLY to `vault/.oms/taxonomy.yaml`.
> Writing to `core/ontology/taxonomy.yaml` or any engine path is FORBIDDEN.

This guard is enforced by construction in `src/engine/setup/writer.ts`:

- `writeTaxonomyToVaultOverride(vaultRoot, data)` resolves the canonical path as
  `{vaultRoot}/.oms/taxonomy.yaml` and refuses any path that escapes `{vaultRoot}/.oms/`.
- Any attempt to write to the engine default throws before touching disk.

**Why this matters:** The engine default at `core/ontology/taxonomy.yaml` is the shared
fallback for every vault. Overwriting it would silently propagate one vault's assumptions
to all future users. Vault-local overrides preserve this separation permanently.

## Recipe

1. **Round-0 topology gate** — list folders, elicit one-sentence vault purpose, provisionally
   map tiers. Block until three tiers are provisionally assigned.

2. **Compute initial ambiguity** across Goal / Constraint / Criteria / Context for all 6
   dimensions together. First pass always yields high ambiguity (~0.8); record it.

3. **Interview D1–D6 in order.** For each dimension:
   a. Ask the targeted dimension question.
   b. Score all four sub-dimensions (goal / constraint / criteria / context).
   c. While `ambiguity > threshold`, probe deeper (max 5 rounds per dimension).
   d. Run Contrarian → Simplifier → Ontologist challenge passes.
   e. If any challenge re-raises ambiguity, re-enter the loop for that dimension only.

4. **Validate completeness** — confirm all 6 output keys are present and non-empty.

5. **Write** to `{vaultRoot}/.oms/taxonomy.yaml` ONLY via
   `writeTaxonomyToVaultOverride(vaultRoot, data)`:
   - Create `{vaultRoot}/.oms/` if it does not exist.
   - Merge with any existing file (do not clobber unrelated keys).
   - Ensure `version: 1` (upgrade from v0 if needed).

6. **Confirm** — print the written path and the resolved values. Never silently succeed.

## Output shape

```yaml
version: 1
folders:
  <name>:
    intent: "<elicited intent>"
    tier: raw | processed | wiki
    provenance: authored | curated | external-raw
    concept: <concept-name> | null
lint:
  schema_ssot: engine_default | vault_override
embedder:
  provider: local | openai | stub
  model: "<model-id>"
ignore_for_external_apis:
  - "<glob>"
agent_writable_zone:
  - "<vault-relative-prefix>"
write_routing_law: append_only | overwrite_allowed | create_only
```

## Shell-out (legacy CLI)

The legacy `oms setup` CLI command remains available for non-interactive use:

```bash
oms setup [--vault <path>] [--yes]
```

`--yes` / `OMS_NON_INTERACTIVE=1` skips all interview prompts and accepts defaults (CI / non-TTY).

## What setup does NOT do

- Does NOT rename, move, or delete any existing notes.
- Does NOT impose a new folder structure.
- Does NOT modify existing frontmatter.
- Does NOT touch `core/ontology/taxonomy.yaml`.

## After setup

Run the `doctor` skill to validate existing notes against the resolved convention:

```bash
oms doctor [--vault <path>]
```

## Executable helpers

Pure stateless helpers live in `src/engine/setup/` (co-located vitest tests):

- `types.ts` — `DimensionScore`, `InterviewConfig`, `TaxonomyOutput`, `BindingDimension`
- `ambiguity.ts` — `computeAmbiguity()`, `meetsThreshold()`, `validateScores()`
- `writer.ts` — `writeTaxonomyToVaultOverride()`, `resolveVaultOverridePath()` (Non-Sticky Guard)
