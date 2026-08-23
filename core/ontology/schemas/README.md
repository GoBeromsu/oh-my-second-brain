# Schema reference assets

The `*.schema.yaml` files in this directory are shipped reference assets. They
are not installed into a vault and are not read by the current setup workflow.

## Setup output

`oms setup` creates the vault's `.oms/` directory and writes:

- `.oms/taxonomy.yaml`, containing the configured folder-to-concept bindings.
- `.oms/concepts/`, containing bundled concept documents from
  `core/ontology/concepts/` when a document does not already exist locally.

Setup does not create `.oms/schemas/` or copy files from this directory. The
live convention model is the taxonomy plus concept documents above.

## Reference files

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

lenses:                # optional named retrieval views
  - name: <lens>
    intent: "..."
    fields: [...]

validation:
  allow_extra_fields: true   # vault notes may carry additional ad-hoc keys
  strict_enum: true          # enum violations are hard errors
```

## Reference constraints

- Changes to these reference files do not change a configured vault.
- The active fields and constraints for a vault live in its `.oms/concepts/`
  documents.
- Adding a required field to an active concept requires updating existing notes.
