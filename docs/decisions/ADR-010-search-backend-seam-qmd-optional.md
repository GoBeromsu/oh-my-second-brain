---
slug: ADR-010-search-backend-seam-qmd-optional
title: "SearchBackend seam — in-repo engine default, qmd optional backend"
status: Accepted
date: 2026-08-24
created_by: gjc
deciders: [beomsu]
relates_to:
  - ./ADR-007-no-fake-embedder-fallback-native-dim-integrity.md
  - ./ADR-008-note-identity-real-path-ssot-no-slug.md
  - ./ADR-009-qmd-compatible-global-collection-bridge.md
---

# ADR-010: SearchBackend seam — in-repo engine default, qmd optional backend

## Status

Accepted

## Context

ADR-009 bundled two independent decisions that must not be retired together.

- **D1 remains in force:** link-based `resolveEffectiveVault` resolution is the
  official vault-selection contract for the verified-target write kernel. A
  local vault, bridge `.oms/links.yaml`, and `OMS_VAULT` take precedence over
  later global-config and cwd fallbacks.
- **D2 is retired:** qmd-compatible CLI/MCP aliases (`query`, `status`, `get`,
  `multi_get` and related aliases) and the `qmd://` resource were declared a
  product interface, but have been removed from the code. They must not remain
  an implied compatibility obligation.

The former qmd-shaped surface was useful as a reference point, but making it a
product contract ties OMS clients and adapters to names and a URI scheme that
are not part of OMS's intended public surface. qmd itself is not required to
provide OMS core search capability.

The reference implementations support that boundary. ouroboros ships multiple
backend adapters under `src/ouroboros/backends/` and detects installed CLI
backends instead of requiring one. gajae-code bundles per-platform native
modules rather than shelling out to a mandatory third-party binary. ADR-007
also prohibits a fake or silent production fallback: an optional backend that
cannot run must report that failure rather than silently substitute degraded
results.

ADR-009 D3 remains in force because `oms link` still records bridge usage in a
project convention file. D4 remains in force because ADR-008's vault-relative
real path remains the canonical document identity. D5 is retired only with D2:
its adapter-parity obligation applied to the removed qmd-compatible aliases and
resource, not to a general qmd dependency.

## Decision

### D1 — SearchBackend is a narrow backend-selection seam

OMS defines a `SearchBackend` seam for selecting an implementation of search.
The seam is an implementation boundary, not a new public compatibility surface.
It does not restore qmd command aliases, MCP aliases, or `qmd://` resources.

### D2 — The in-repo engine is the default

The in-repo OMS engine is the default `SearchBackend`. It remains sufficient
for core OMS search and does not require qmd or another third-party binary.

### D3 — qmd is optional and explicit

qmd may be supplied as one pluggable `SearchBackend` alternative. It is neither
the default nor a requirement for installation, startup, or core capability.
Selecting qmd is explicit. When it is selected but unavailable, incompatible,
or fails, OMS fails loudly; it does not silently fall back to fabricated,
stale, or degraded search results. This applies ADR-007's no-fake-fallback
rule to optional backend selection.

### D4 — The seam deliberately excludes backend-management infrastructure

This decision introduces only the backend seam. It does not introduce:

- versioned backend schemas,
- a trust store,
- a lockfile,
- a firewall,
- a user-level backend registry.

Those mechanisms have no current product requirement and would expand a narrow
selection boundary into an unneeded plugin platform.

## Alternatives Considered

### (A) Keep qmd compatibility as an OMS product contract — rejected

The aliases and `qmd://` resource have already been removed. Preserving their
contract would reintroduce obsolete surface area and adapter parity obligations
without making OMS search more capable.

### (B) Make qmd the required or default backend — rejected

A core OMS capability must not depend on a third-party binary. This conflicts
with the in-repo engine and the reference precedent of optional, detected
backends.

### (C) Silently use another backend when selected qmd is unavailable — rejected

Silent substitution obscures which search semantics were used and violates
ADR-007's prohibition on unintended production fallbacks. Selection failures
must be observable.

### (D) Build a general plugin registry now — rejected

Version negotiation, trust policy, lockfiles, firewalling, and user-level
registry management solve problems outside the current seam. They are excluded
rather than pre-built.

## Consequences

### Enables

- OMS retains a self-contained default search path.
- qmd can be integrated where it is useful without becoming an OMS prerequisite.
- Backend selection can evolve without restoring qmd-named CLI, MCP, or
  resource compatibility contracts.

### Costs / trade-offs

- A selected optional backend can fail instead of producing substituted results;
  callers must handle that explicit failure.
- qmd-specific behavior is no longer guaranteed across OMS adapters or clients.
- Future backend-management features require their own ADR and product need.

### New constraints

- The in-repo engine remains the default `SearchBackend`.
- Optional backend selection is explicit and unavailable selected backends fail
  loudly.
- No versioned schemas, trust store, lockfile, firewall, or user-level registry
  is implied by this seam.
