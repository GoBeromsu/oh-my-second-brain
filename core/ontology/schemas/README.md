# core/ontology/schemas/

Layer 1 CONTRACT — frontmatter schema definitions for all vault note types.

## What lives here

Each `*.schema.yaml` file declares the allowed frontmatter fields, types, enums,
and required flags for one note type. These files are the authoring source;
at vault setup time, `vault-scaffold` copies them into the vault's own `.oms/schemas/`.

## Current schemas

| File | Note type | Key constraint |
|------|-----------|----------------|
| `note.schema.yaml` | Base note (all types) | `title` required; `status` enum-guarded |
| `concept.schema.yaml` | Evergreen / wiki concept | Extends base; `status` required; defines 3 retrieval lenses |

## Schema file format

```yaml
schema: <name>         # matches the concept name in taxonomy.yaml
version: 1
extends: <parent>      # optional — inherits fields from parent schema
intent: "..."          # single-sentence description (machine-readable label)

fields:
  - name: <key>
    type: string | list | date | datetime | url | enum | boolean
    required: true | false
    intent: "..."      # why this field exists
    enum: [...]        # only when type: enum
    normalize: kebab   # optional — normalize list values to kebab-case

lenses:                # optional — named retrieval views (see retrieve skill)
  - name: <lens>
    intent: "..."
    fields: [...]

validation:
  allow_extra_fields: true   # vault notes may carry additional ad-hoc keys
  strict_enum: true          # enum violations are hard errors in vault-lint
```

## Invariants (ADR-006 Layer 1)

- These files are parsed by `vault-lint` and `oms_validate_contract`. No prose rationale.
- Rationale for *why* a field exists belongs in `.oms/governance/` (Layer 2), not here.
- Adding a required field is a breaking change — all existing notes must be migrated first.
- `allow_extra_fields: true` is the default; vault notes routinely carry personal ad-hoc keys.
