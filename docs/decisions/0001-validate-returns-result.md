# ADR 0001: validateFrontmatter Returns a Result, Never Throws

## Status

Superseded by [ADR-015](./ADR-015-explicit-vault-contract-and-agent-owned-judgement.md). The
`validateFrontmatter(Concept)` API and the top-level `oms doctor` command it
describes were both retired; version-5 admission is `evaluateContractV5` and
diagnosis is `oms template check` / `doctor` + `validate`. The result-not-throw
principle it argued for still holds wherever a caller receives a report.

## Context

Oh My Second Brain's v0 enforcement model is `onViolation: warn` — convention mismatches are informational, not blocking. The `validateFrontmatter` function is the central enforcement point: it receives a note's parsed frontmatter and a `Concept` definition and decides whether the frontmatter satisfies the declared field schema.

Two implementation shapes were considered:

1. **Throw on violation** — `validateFrontmatter` raises an exception when a required field is absent or a type does not match. Callers catch it if they want to continue.
2. **Return a result** — `validateFrontmatter` always returns a `ValidationResult { valid: boolean, violations: Violation[] }` and never throws. Callers inspect the result.

The choice of shape has downstream effects on every caller: the CLI `doctor` command, the MCP stub, and any future agent that invokes validation inline.

## Decision

`validateFrontmatter` **returns** `ValidationResult` and **never throws**.

```typescript
export interface Violation {
  field: string;
  rule: "required" | "type" | "immutable";
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  violations: Violation[];
}

/**
 * Validate `frontmatter` against the field schema of `concept`.
 *
 * NEVER throws — all violations are collected and returned.
 * Undeclared frontmatter keys produce no violation (additionalProperties: preserve).
 *
 * NOTE (v0): the `immutable` rule is a NO-OP. No baseline snapshot is available,
 * so immutable violations are never emitted. The `"immutable"` union member in
 * `Violation.rule` is kept for forward-compatibility with v1.
 */
export function validateFrontmatter(
  frontmatter: Record<string, unknown>,
  concept: Concept,
): ValidationResult { ... }
```

The function collects all violations into an array and returns them. It does not short-circuit on the first violation, does not log, and does not call `process.exit`.

The `immutable` rule within `Violation.rule` is intentionally kept in the union even though no code path emits it in v0. When a field is declared `immutable: true`, the field is validated for presence and type only; the immutability constraint is silently skipped. JSDoc on the function states this explicitly.

`oh-my-second-brain doctor` (or `oms doctor`) inspects the returned `ValidationResult`, formats violations as human-readable warnings, and **exits 0 regardless of `valid`**. There is no exit code that signals "convention violated" in v0.

## Consequences

**Positive:**

- The enforcement model matches `onViolation: warn` at the API level, not just in documentation. There is no way for a caller to accidentally propagate a validation failure as an uncaught exception.
- Agent workflows that call `validateFrontmatter` inline are never interrupted by a convention mismatch. The convention layer is truly advisory in v0.
- The result type is composable: callers can aggregate violations across many notes before reporting, which is how `doctor` works (walk all notes, collect, then print summary).
- Adding a stricter enforcement tier in v1 (e.g., `onViolation: error`, exit code 1) requires only a caller-side change — the function signature stays the same.

**Negative / Trade-offs:**

- Callers **must** inspect the returned result. A caller that discards `ValidationResult` silently ignores all violations. Code review and documentation must enforce this discipline.
- `doctor` exits 0 even when every note in the vault violates its declared concept. Users who want a CI gate in v0 must add their own wrapper. This is a known and intentional limitation.
- The `immutable` union member in `Violation.rule` is dead code in v0. It adds a small amount of noise to the type definition and any future exhaustive switch on `rule`. The benefit (no breaking schema change in v1) outweighs this.

## Rejected Alternative: Throw on Violation

A throwing implementation would align with the fail-fast style common in parsers and schema validators (e.g., Zod's `.parse()`). The argument for it: violations are programmer errors (the note was written wrong) and should be loud.

This was rejected because:

1. Oh My Second Brain's declared enforcement policy is `onViolation: warn`. An exception-throwing function implements `onViolation: error` at the API level and forces every caller to add try/catch boilerplate to recover the non-blocking behavior promised by the policy.
2. `oh-my-second-brain doctor` needs to validate an entire vault and report a summary. A throwing validator would require either catching and continuing in a loop (awkward) or a separate "collect" wrapper on top of the throwing function (duplication).
3. Host agents invoking validation inside a larger workflow must not be aborted by a missing frontmatter field. The convention layer must be transparent to the host's own error handling.
