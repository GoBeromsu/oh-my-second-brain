# Harness Architecture

Oh My Second Brain is an Obsidian-first convention layer over plain Markdown. Obsidian remains the command center and the vault remains readable without OMS.

## Authority model

A vault composes four authorities:

1. Actual Obsidian Markdown templates own frontmatter shape and body scaffolding.
2. `.obsidian/types.json` is read-only property-type authority.
3. `.oms/template-policy.json` owns requiredness, formats, allowed values, defaults, naming, stable IDs, and bindings.
4. `.oms/taxonomy.json` owns physical placement and global folder/link axes.

Every managed template inherits one vault-wide `BaseContract`. A stable `templateId` does not depend on source path or content digest. `.oms/types.json` is a derived, validated write/search projection and is never user-authored authority.

## Prepare → Admission Check → Write → Evaluate

All note and control mutations follow one pipeline:

- **Prepare:** resolve the target, template, defaults, naming, paths, and source signatures once.
- **Admission Check:** require a verified target, safe paths, explicit approval digest where applicable, and current compare-and-swap expectations. Failure has no side effects.
- **Write:** publish through the guarded note writer or template transaction.
- **Evaluate:** read persisted state back and return a server-verifiable postcondition receipt.

Create applies defaults and template body scaffolding. Append changes body only. Update preserves omitted fields and does not revive deleted defaults. Unknown frontmatter and template extensions are preserved.

## Setup and migration

Setup recursively discovers actual templates, explicit registered sources, Obsidian types, taxonomy, and legacy vault controls needed for one-shot migration. It reports duplicate, unsafe, and unresolved mappings before activation. One source may produce deterministic clones when taxonomy placement is one-to-many.

Setup is proposal-driven: run `setup --dry-run`, review the manifest and digest, then apply with `--yes --approved-digest <digest>`. Publication is atomic and resumable; setup never self-approves or modifies notes.

## Retrieval

Writes, typed search, graph construction, and linking consume the same resolved template projection.

- `axes.template` uses stable note identity from frontmatter `template` only.
- `axes.field.<key>` accepts only fields declared for that template.
- folder and link axes come from the same resolved convention.
- managed template source paths are excluded from note indexes, graph candidates, and embeddings.

Plain lexical retrieval is projection-independent and read-only. Typed axes fail loudly on missing/malformed projection or stale index signatures. Vector and HyDE requests fail loudly unless both embedding provider and model are configured.

## Maintenance

`status` is read-only. `doctor` owns diagnosis and repair operations. Template diagnosis reports policy/projection/source drift, migration state, managed exclusions, and unresolved legacy notes. Projection regeneration and one-note identity backfill require a verified target, dry-run proposal, exact caller-approved digest, CAS, and postcondition receipt.

## Surfaces

The public sets are intentionally different:

- seven skills: write, search, link, distill, status, doctor, template;
- five MCP tools: `oms_write`, `oms_search`, `oms_link`, `oms_status`, `oms_doctor`;
- an independent CLI command allowlist.

Detail capabilities remain `op` values under the five tools. Host adapters differ natively, but all register the same MCP runtime and stamp the selected vault into their managed `oms mcp --vault` entry. That stamp never changes runtime resolution precedence: explicit target, local vault controls, bridge, `OMS_VAULT`, then read-only cwd fallback.
