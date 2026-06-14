# vault-lint — CHANGELOG

## 0.1.0 — 2026-06-13

Initial release (M5 governance skills, step 3 — vault-lint checker).

### Added

- `src/engine/conventions/vault-lint.ts` — Five-check Layer 1 CONTRACT enforcer.
  Pure `lintNoteFrontmatter()` for unit testing + async `lintVault()` walker.
  Wraps `src/conventions/validate.ts` for checks (2) required and (3) type.
  Adds (1) allowlist, (4) enum, (5) routing-law natively.
  Autofix guard present; no mutations without explicit `autofixEnabled: true` human-gate.

- `src/engine/conventions/vault-lint.test.ts` — 15 co-located vitest tests.
  Covers all five check rules with known-BAD fixtures (rogue key, missing-required,
  wrong-type, bad-enum, missing `created_by` in agent zone) and known-GOOD fixtures
  (valid note, note outside agent zone, note with optional fields absent).
  Uses inline/temp fixtures — never reads the real vault.

- `src/engine/conventions/README.md` — Sub-dir README per R21 convention.

- `src/engine/conventions/ACKNOWLEDGMENTS.partial.md` — Local attribution fragment
  for orchestrator merge at M5.

- `core/skills/vault-lint/SKILL.md` — /skillify recipe, 5-key frontmatter,
  checker-lane-only constraint documented.

### Attribution

| Source | License | Absorption |
|--------|---------|------------|
| `src/conventions/validate.ts` (self-authored) | Self-authored | Direct import — `validateFrontmatter()` delegates checks (2) + (3) |
| `src/conventions/lint.ts` (self-authored) | Self-authored | Walk pattern reference — reimplemented independently |
| `src/conventions/frontmatter.ts` (self-authored) | Self-authored | Direct import — `parseNote()` for frontmatter splitting |
