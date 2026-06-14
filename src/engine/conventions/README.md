# conventions

Vault-level Layer 1 CONTRACT enforcement for the OMS engine.

This sub-module is the **checker lane only** — it reads vault notes and reports
violations; it never authors or mutates content.

## Files

| File | Role |
|------|------|
| `vault-lint.ts` | Five-check vault-lint runner; wraps `src/conventions/validate.ts` |
| `vault-lint.test.ts` | Co-located vitest suite (inline fixtures, no real vault) |

## Five checks

| # | Rule | Description |
|---|------|-------------|
| 1 | `allowlist` | No frontmatter key outside the concept's declared field list |
| 2 | `required` | Required fields must be present and non-empty |
| 3 | `type` | Values must match the declared `FieldType` |
| 4 | `enum` | String fields with an `enum` constraint must use a listed value |
| 5 | `routing-law` | Notes in agent-writable taxonomy zones must carry `created_by` |

## Autofix guard

`lintVault()` is report-only by default. The `autofixEnabled` option flag is
intentionally a no-op until a human-gate protocol is specified and approved for
M5 vault mutations. Never set it programmatically.

## Integration

```ts
import { lintVault } from "./src/engine/conventions/vault-lint.js";
import { loadOntology } from "./src/ontology/loader.js";

const ontology = await loadOntology(".oms/ontology");
const report = await lintVault("/path/to/vault", ontology);
if (!report.clean) {
  for (const v of report.violations) {
    console.warn(`[${v.rule}] ${v.notePath} — ${v.field}: ${v.message}`);
  }
}
```
