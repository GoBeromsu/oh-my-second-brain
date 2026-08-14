# Oh My Second Brain Vault Convention — SSOT for Host Agents

This file is the authoritative reference a host agent (Claude Code, Codex, Hermes, or any
other) reads when working inside a vault managed by Oh My Second Brain. It explains the convention model so
the agent understands *why* knowledge is organized the way it is — not just *where*.

---

## What is a Convention?

An Oh My Second Brain **convention** is declarative semantic data the **user owns**. It lives in
`vault/.oms/` (copied there by `oms setup`; Oh My Second Brain ships the defaults in `core/ontology/`).
The user edits it freely. Oh My Second Brain enforces whatever is declared — it does not impose structure.

The convention has four building blocks:

---

## 1. Concept

A **concept** is a note-type. Each concept carries:

| Field    | Purpose |
|----------|---------|
| `concept` | Identifier (e.g. `literature`). |
| `intent`  | One sentence: *what this knowledge is FOR.* |
| `folder`  | The vault folder where notes of this type live. |
| `fields`  | List of frontmatter keys the concept declares. |
| `lenses`  | Named retrieval views (optional). |

> "The folder itself is information — every folder declares its intent."
> Rather than pattern-matching a directory listing, a host agent reads the declared `intent`
> to understand *why* knowledge lives in a given folder.

---

## 2. Field

A **field** is one frontmatter key — the smallest unit of convention. Each field declares:

| Property   | Meaning |
|------------|---------|
| `name`     | The frontmatter key (kebab-case, e.g. `source-url`). |
| `type`     | One of `string`, `url`, `date`, `list`, `number`, `boolean`. |
| `required` | Whether the key must be present and non-empty. |
| `intent`   | Semantic purpose: *what this field is FOR.* |
| `normalize` | Optional: `kebab`, `lower`, or `trim` — applied at validation. |
| `immutable` | Advisory: once written, should not change (v0: no-op, forward-compat). |
| `enum` | Optional closed vocabulary for string fields; values outside it are lint violations. |

Users grow their convention field-by-field. There is no mandatory field list.

---

## 3. Lens

A **lens** is a pre-declared, named retrieval view. It is NOT a query filter — it is a
concept's declaration of which fields matter for a specific retrieval purpose.

Example: a `synthesis` lens on `literature` surfaces `title` and `source-url`, because those
are the fields needed when synthesizing across references. A host agent uses the active lens
to know which frontmatter to surface during retrieval.

---

## 4. Taxonomy

The **taxonomy** binds folders to concepts and gives each folder a declared `intent`.

```yaml
version: 1
folders:
  references:
    intent: "Processed external sources the user has read and synthesized."
    concept: literature
  inbox:
    intent: "Unprocessed captures awaiting triage."
    concept: inbox
```

A folder may bind to one concept, multiple concepts (list), or `null` (not yet assigned). A folder binding may set `agentWritable: true`; paired with `routingLawStrict: true`, notes in that folder must carry `created_by`. Top-level `exclude` entries are vault-relative globs skipped by audit/lint scans.

---

## Enforcement Posture

| Setting | Value | Meaning |
|---------|-------|---------|
| `onViolation` | `warn` | Violations are logged but never block writes (v0 is non-blocking). |
| `additionalProperties` | `preserve` | Frontmatter keys not declared in the concept are left untouched. |

Oh My Second Brain enforces what the user declared; it does not touch anything else.

---

## User Ownership

1. `oms setup` scans the vault's existing top-level folders and creates `vault/.oms/`.
2. It copies shipped default concepts into `vault/.oms/concepts/` and writes
   `vault/.oms/taxonomy.yaml` — seeded with the user's real folders.
3. The user fills in `intent` values and adds or removes fields/lenses freely.
4. Oh My Second Brain never imposes a folder structure; it adopts what already exists.

---

## Quick Reference for Host Agents

- To understand a note: look up its folder in the taxonomy → read the `concept.intent`.
- To validate frontmatter: load the concept's `fields`; check `required`, `type`, and any `enum`.
- To retrieve knowledge: apply the relevant `lens` to surface the fields that matter.
- To audit a vault: honor taxonomy `exclude` globs and routing-law flags.
- When in doubt, preserve: `additionalProperties: preserve` means unknown keys are safe.
