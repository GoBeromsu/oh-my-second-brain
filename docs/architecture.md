# OMSB Architecture

## Source hierarchy

1. **Guideline folder**
   - Human-written source of truth.
   - Explicit domain mappings identify which file covers the folder guideline and which file covers the frontmatter guideline.
2. **`omsb.config.json`**
   - Vault-scoped mapping, routing fallback, managed plugin registry, compile settings.
3. **`.omsb/rules.json`**
   - Mechanically generated rule manifest and source snapshot.

## Activation predicate

OMSB enforcement is active only when the current vault/repo has:

- readable `omsb.config.json`
- readable `.omsb/rules.json`
- a freshness-clean guideline source snapshot

## Routing contract

Every note-routing decision must resolve to one of:

- `explicit`
- `inbox`
- `propose`

## Obsidian-native boundary

Prefer Obsidian CLI/plugin for:

- user-visible note creation
- note move / rename / routing

Direct filesystem operations remain acceptable for:

- config generation
- rules generation
- generated docs
- compile outputs
- managed plugin `data.json` writes
