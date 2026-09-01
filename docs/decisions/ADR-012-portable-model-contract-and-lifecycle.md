---
slug: ADR-012-portable-model-contract-and-lifecycle
title: "Portable model contract and lifecycle — tracked identity, local verification, immutable embedding lineage"
status: Accepted
date: 2026-08-30
created_by: gjc
deciders: [beomsu]
relates_to:
  - ./ADR-007-no-fake-embedder-fallback-native-dim-integrity.md
  - ./ADR-010-search-backend-seam-qmd-optional.md
  - ./ADR-011-search-reranking-opt-in.md
---

# ADR-012: Portable model contract and lifecycle — tracked identity, local verification, immutable embedding lineage

## Status

Accepted

## Context

OMS needs a portable declaration of which model a vault intends to use without
tracking host-specific weight locations or claiming that a model is usable
merely because it was named. The runtime must distinguish that portable
identity from a model installation that has been verified on the current host.

This boundary also governs embedding compatibility.
[ADR-007](./ADR-007-no-fake-embedder-fallback-native-dim-integrity.md) requires
real, native-dimension embeddings and forbids fake production fallbacks. A
change to model revision, weights, checksum, or prompt formatting changes
embedding meaning even when a model name remains the same.
[ADR-010](./ADR-010-search-backend-seam-qmd-optional.md) keeps the in-repo
engine as the default search backend, and
[ADR-011](./ADR-011-search-reranking-opt-in.md) keeps reranking explicit
opt-in.

## Drivers

- Keep `.oms` portable, reviewable, and safe to commit.
- Verify actual host-local model availability before a capability is offered.
- Make configuration precedence deterministic and prevent malformed high-tier
  configuration from silently changing behavior.
- Preserve embedding index integrity across model and prompt changes.
- Keep model loading, lifecycle, and cleanup ownership unambiguous.
- Retain lexical-only search when semantic capabilities are unavailable without
  fabricating models, weights, or results.

## Decision

### D1 — tracked identity and host-local verification are separate

`.oms/models.json` is a strictly validated, tracked v1 identity-only
descriptor. It identifies a requested model but contains no absolute local
paths, installed-weight metadata, or host-specific state.

Host-local setup writes `installed-models.json`. URL acquisitions place verified
weights in the user cache; a descriptor may instead register an existing local
GGUF by `path`. Registration canonicalizes the real regular-file target, rejects
vault-internal paths including symlink targets, verifies the declared SHA-256,
and records that canonical host-local path only in the installation receipt.
Runtime re-verifies the receipt and artifact before use; a tracked identity alone
does not make a model available.

### D2 — model resolution is ordered and fails closed

For each capability, resolution order is:

1. explicit request;
2. complete environment pair;
3. vault descriptor;
4. setup-installed default;
5. unavailable.

Environment configuration is capability-specific and requires the applicable
complete pair (for example, `OMS_EMBEDDING_PROVIDER` and
`OMS_EMBEDDING_MODEL`). Guidance names the missing capability-specific pair and
the vault/setup alternatives. Version 1 is deliberately local-GGUF-only:
the former remote Upstage branch did not satisfy the installed-artifact lineage
contract and is removed rather than retained as a parallel authority. A
malformed, incomplete, or uninstalled higher tier is an error and never falls
through to a lower tier.

### D3 — embedding lineage is immutable

The embedding fingerprint includes immutable model revision, verified checksum,
and prompt scheme in addition to the model identity. Index metadata is version
3. There is no migration and no dual-read of prior metadata: an incompatible
fingerprint or prior metadata version requires re-embedding.

EmbeddingGemma and Qwen prompt formats are named, data-driven prompt schemes,
not model-name conditionals scattered through runtime logic.

### D4 — assembly owns production reranker lifecycle

Kernel assembly owns lazy construction of the production reranker. ADR-011's
explicit `rerank` opt-in remains unchanged. Callers that inject a reranker own
that injected instance; kernel assembly owns instances it creates. Each owned
instance is disposed exactly once.

### D5 — no hidden semantic behavior

A plain query remains lexical-only. Runtime never downloads models or weights
and never fabricates a model, embedding, reranker, or fallback result.

Two production paths violated this and were removed under this decision, recorded
here so the principle is auditable rather than merely declared:

- **Identity HyDE.** `dispatcher.ts` defaulted its HyDE generator to a stub that
  returned the query unchanged, so an explicit `hyde` request embedded the raw
  query and still reported itself as HyDE. There is now no default generator: an
  absent one fails and names both capabilities HyDE requires — a generate model to
  write the hypothetical document and an embed model to embed it. Generator output
  that is empty, or that merely echoes the query, is rejected for the same reason.
- **Passthrough-as-success.** `PassthroughReranker` was exported from the
  production retrieval barrel as the "default no-op reranker". Because reranking
  availability is decided by whether a reranker is defined at all, injecting that
  no-op made an explicit `rerank: true` request report success while returning the
  unchanged fused order. The correct production state for an unconfigured reranker
  is absent, not inert; the no-op implementation is now test-only, and ADR-007's
  existing rule that test stubs may not be imported by production modules is
  enforced by an architecture gate instead of resting on a file comment.

Both removals delete a fake capability. Neither adds a real one: HyDE generation
remains unavailable until a generation model is configured.

## Why chosen

An identity-only tracked contract allows vaults to express intent without
leaking or invalidating host paths. Separating it from verified local
installation evidence makes availability truthful. Ordered fail-closed
resolution prevents an operator's malformed explicit configuration from being
silently replaced by another model.

Versioned immutable lineage makes embedding compatibility inspectable and
avoids serving vectors produced with changed weights or instructions. Owning
lazy production construction in kernel assembly keeps lifecycle management out
of CLI and MCP adapters while preserving caller injection for tests and
specialized hosts.

## Alternatives Considered

### Store absolute weight paths in the vault descriptor — rejected

Absolute paths make tracked vault configuration host-specific and non-portable.

### Permit loose descriptors or model aliases — rejected

Permissive identity forms cannot provide stable, verifiable model lineage.

### Silently fall back after invalid configuration or unavailable capability — rejected

Silent substitution violates ADR-007 and obscures which model behavior was
actually used.

### Give CLI or MCP adapters model lifecycle ownership — rejected

Adapters should request capabilities, not independently construct and dispose
shared production model resources.

### Eagerly load production models — rejected

Startup should not incur model cost for unused opt-in capabilities.

### Migrate or dual-read existing embedding metadata — rejected

Compatibility shims would conceal a semantic index change. Re-embedding is the
explicit correctness boundary.

## Consequences

### Implemented in 0.10.0

0.10.0 ships the strict portable model contract, verified host-local
installations, immutable embedding lineage, and kernel-owned lazy reranker
lifecycle described above. It also ships the real generator path for explicit
HyDE and expansion requests, plus taxonomy-derived folder-intent context for
expansion and reranking prompts. Those capabilities remain explicit and fail
loudly when their required model capability is unavailable; a plain query stays
lexical-only.

### Enables

- Portable tracked model intent with verified host-local availability.
- Deterministic capability-specific diagnostics and configuration behavior.
- Explicit re-embedding when model lineage changes.
- Lazy, exactly-once managed production reranker resources.
- Usable lexical-only plain queries without semantic-model side effects.

### Costs and constraints

- Setup and user cache are required before a locally installed model is
  available.
- Invalid high-precedence configuration blocks resolution instead of using a
  lower-precedence default.
- Existing embedding metadata is not read or migrated by meta v3; affected
  indexes must be re-embedded.
- Callers injecting rerankers must dispose their own instances.

## Follow-ups

- Numeric benchmark work is deferred to a later approved milestone.
- This ADR makes no replacement, parity, or outperformance claim about qmd.
