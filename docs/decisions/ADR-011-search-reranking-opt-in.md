---
slug: ADR-011-search-reranking-opt-in
title: "Search reranking — explicit opt-in until a production reranker exists"
status: Accepted
date: 2026-08-24
created_by: gjc
deciders: [beomsu]
relates_to:
  - ./ADR-007-no-fake-embedder-fallback-native-dim-integrity.md
  - ./ADR-010-search-backend-seam-qmd-optional.md
---

# ADR-011: Search reranking — explicit opt-in until a production reranker exists

## Status

Accepted

## Context

M4 specified `rerank: true` as the search default. OMS production startup does
not assemble a `Reranker`, however. Applying that default would make ordinary
search requests fail with a missing-reranker error, rather than providing a
usable default search path. Supplying a fake reranker or silently returning
unranked results would conflict with ADR-007's requirement that unavailable
capabilities fail explicitly.

## Decision

`rerank` is opt-in and defaults to `false`. A caller that sets `rerank: true`
receives reranking only when startup has been given a real `Reranker`; otherwise
the request fails loudly with configuration guidance. The public MCP schema and
SearchBackend normalizer advertise and apply this default.

## Alternatives Considered

### Default `rerank` to true without configuring a reranker — rejected

This makes the normal search path unavailable in every ordinary `oms mcp`
startup.

### Silently ignore `rerank: true` when unavailable — rejected

It misrepresents the result and violates ADR-007's no-fake-fallback principle.

### Bundle a placeholder reranker — rejected

A placeholder would advertise precision behavior that OMS cannot provide.

## Consequences

### Enables

- Default search remains available without an optional precision dependency.
- Explicit reranking has an honest success or failure contract.

### Costs / trade-offs

- Callers must opt in and configure a real reranker to receive reranked
  results.
- Making reranking default-on in the future requires a production reranker and
  a new recorded decision.

### New constraints

- `rerank: true` must never silently degrade to unranked retrieval.
- The default remains `false` until a production reranker is assembled by
  default.
