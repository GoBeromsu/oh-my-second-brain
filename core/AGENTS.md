# Oh My Second Brain Vault Convention — SSOT for Host Agents

This file defines the end-user vault convention for host agents (Claude Code, Codex,
Hermes, and others). All convention data and its meaning remain vault-owned.

## Four Separate Authorities

These authorities do not overlap:

1. **Markdown templates — shape and body.** Actual vault Markdown templates own
   frontmatter-key scaffolding, default literals, and note body shape. Do not infer
   semantic meaning from a template's defaults.
2. **Ontology policy — note and field meaning.** `.oms/template-policy.json` owns
   `intent` for notes and frontmatter fields. It is the note/field portion of the
   semantic ontology, not template shape or type authority.
3. **Taxonomy — placement and folder/link ontology.** `.oms/taxonomy.yaml` owns note
   placement and the folder/link portion of the semantic ontology, expressed through
   folder and link `intent`. Authored folder intents surface on the derived
   `folder-ontology` axis.
4. **Obsidian types — type authority.** `.obsidian/types.json` is the read-only type
   authority. `.oms/types.json` is derived output, never an independent authority.

## Operating Boundaries

- Treat the verified target note and its applicable vault template as the write
  boundary. Write only after verifying that target; never use a destination merely
  because a template default suggests it.
- Read ontology and taxonomy to understand declared meaning and placement. Do not
  overwrite them as a side effect of writing a note.
- Read `.obsidian/types.json` without modifying it. Do not edit derived
  `.oms/types.json` as a source of truth.
- Preserve unknown frontmatter fields and their values. The convention constrains only
  what the user declared.

## User Ownership

The user owns templates, ontology, taxonomy, and type definitions in the vault.
Oh My Second Brain applies those declarations without making them sticky: it does not
impose a folder structure, retain obsolete declarations, or replace user-authored
meaning. The user-owned semantic ontology remains active across ontology policy and
taxonomy; it is separate from template shape and type authority.

## Quick Reference for Host Agents

- For note shape and default values, read the applicable vault Markdown template.
- For note or field ontology, read `intent` in `.oms/template-policy.json`.
- For destination and folder/link ontology, read `.oms/taxonomy.yaml`.
- For types, read `.obsidian/types.json`; treat `.oms/types.json` only as derived data.
- When in doubt, preserve user-authored content and unknown frontmatter.
