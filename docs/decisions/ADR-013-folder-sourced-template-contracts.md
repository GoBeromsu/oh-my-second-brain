---
slug: ADR-013-folder-sourced-template-contracts
title: "선택 폴더 원본 템플릿 계약 — 인터뷰로 확인하는 파생 controls"
status: Superseded
superseded_by: ./ADR-014-user-owned-contract-completion-harness.md
date: 2026-09-14
created_by: gjc
deciders: [beomsu]
relates_to:
  - ./ADR-003-oms-vault-convention-asset.md
  - ./ADR-006-oms-governance-contract-separation.md
---

# ADR-013: 선택 폴더 원본 템플릿 계약 — 인터뷰로 확인하는 파생 controls

## Status

Superseded by [ADR-014](./ADR-014-user-owned-contract-completion-harness.md).
The decisions below record the earlier design, not the current contract
authority, rendering responsibility, or completion policy.

## Context

A per-file registration ritual made an existing Markdown template unusable
until a binding was manually admitted. It also coupled unrelated templates to
one stale projection and treated the body as opaque. The source is already
user-owned Markdown, while semantic meaning belongs to the user's policy and
taxonomy. OMS needs a review path that discovers source changes without
rewriting source files, preserves confirmed meaning, and cannot publish a
contract from stale or self-approved answers.

## Drivers

- Remove hidden per-file registration and obsolete automatic/manual mode
  semantics without broadening scope accidentally.
- Keep source bytes and authored policy meaning intact while limiting a source
  change's blast radius.
- Make the notice-to-review flow usable by both fresh and long-lived hosts.

## Decision

### 1. Selected folders are the source census scope

The user explicitly selects template folders. Every `.md` beneath a selected
folder is a candidate; no per-file registration or folder mode is required.
The census classifies adds, edits, deletes, and renames. Review reads and
verifies the selected source at its existing path. Explicit source authoring
(`oms template add --id <id> --from <file>`) and update, move, remove, and
default operations remain separate guarded operations.

### 2. Authority and freshness are two-tiered

The source Markdown plus current user-owned policy, taxonomy, and Obsidian
property types determine the derived contract. Policy-confirmed metadata and
body semantics are authoritative; an interview ledger is only an untrusted
draft of answers until the current request CAS and each answer's anchored
source slice still match.

`sharedAuthoritySignature` hashes the raw whole bytes of
`.oms/template-policy.json` (including bindings, naming, and extensions),
`.oms/taxonomy.json`, and `.obsidian/types.json`. OMS verifies this shared tier
first and fails closed for the whole vault on mismatch. Only then does it mark
an affected source's dependent template `pending`; unrelated templates remain
usable. A historical ledger census is not a blanket stale rejection: the
current request CAS and per-answer anchor checks decide validity.

Approved review and source authoring record `approvedSourceSignature` and
`approvedBodySignature` from actual source bytes in policy. Full-source proof
can authorize identical-byte identity continuity; raw-body proof only suggests
confirmation-required renames, including after restart without a content
contract. Neither a derived descriptor nor its body hash is independent proof.
These observations do not infer requiredness or replace authored body semantics.
Mutation and taxonomy identities are NFC-canonical before routing, with
canonical definition collisions rejected rather than silently losing placement.

### 3. Contracts describe metadata and bounded body structure

OMS derives frontmatter keys, types, requiredness, and `filledBy`, and a bounded
body contract containing supported ATX headings, fenced code blocks, ordered or
unordered list runs outside fences, and `<!-- oms:content -->`, together with
document order, EOL, BOM, and final-newline details. Each supported body node
can carry requiredness and order. This is not a claim that paragraphs, setext
headings, or arbitrary Markdown are enforced.

Repeated body nodes are contextualized by their surrounding structure and
anchored source span before a question is formed; they are not collapsed by a
global name alone. If a required body rule is missing or ambiguous, the flow
asks for an explicit disposition. It never invents a blocking rule, silently
removes a requirement, or auto-repairs the source.

Unsupported template expressions are a blocking diagnostic for this review
path. They cannot produce a confirmation or guarded reconcile, and a blocked
source causes no control or source write.

### 4. Review is an anchored, resumable interview

The initial host display is exactly `템플릿에 변경이 있습니다` with exactly
`확인하기` and `나중에`; it displays no template name, hash, or change class.
`나중에` is host-only: it makes no server call and does not mutate the ledger.
`확인하기` starts `write { op: "template", mode: "interview-next" }`.
Answers use `interview-answer`; resume follows the server-returned next
question and forwards its request/CAS fields without inventing spellings.
Unchanged confirmed answers survive, and zero questions goes directly to final
confirmation. A lock serializes answer application; stale current CAS or
changed answer anchors must be re-read rather than overwritten.

Runtime interview audit events remain best-effort and external to the vault:
question lifecycle events keep the existing event kinds, carry the question ID
in `transactionId`, and carry its bounded question kind in the operation label;
commit events carry the verified receipt transaction ID and approval digest in
the parameterized operation label, while one event per actually written
`.oms` control uses `notePath` as a generic vault-relative path carrier.
Preview and rejected outcomes emit no write-path events, and telemetry failure
never changes the ledger, source, or guarded transaction result.

The exact CLI counterparts are `oms template review`, `oms template answer`,
and `oms template commit`. The CLI answer form is:

```text
oms template answer <question-id> --answer <JSON> --census-digest <digest> --ledger-digest <digest|null>
```

Commit uses the same CAS fields and the existing dry-run or
`--yes --approved-digest <digest>` guard. `commit-contracts` is called only
with the exact final digest the user approved; there is no self-approval.

The public confirmation proposal is a byte-free description: it retains source
and control paths, actions, CAS expectations, signatures, payload/output
digests, operations, moves, and diagnostics, but does not expose manifest
`Uint8Array` payloads. Commit re-reads the vault and rebuilds the full
manifest internally; the reported approval digest and request fields remain
unchanged.

When a policy-bound source is independently observed absent, a previously
committed `defer` disposition is reopened only in memory by an explicit
`interview-next`/review read. The read does not rewrite the interview ledger,
and `나중에` remains host-only with no RPC. Answering the reopened question
uses the current census and ledger CAS, preserves the other saved answers, and
may change the disposition to `retire`. Absence that was not independently
verified is not treated as deletion evidence or rename identity.

### 5. Reconcile publishes controls only

A confirmed reconcile publishes only `.oms` controls through the existing
approval-digested, guarded transaction. Every source transition is
verify-only; source Markdown and existing notes are not rewritten. Placement is
not required for review. At note creation, destination precedence is explicit
caller folder, then taxonomy default, then `ask`; there is no registration
prerequisite and no Inbox fallback.

Approval retains the captured-control and known-source byte comparisons and
also rechecks the complete selected census. A newly appearing unbound source,
not just a changed known path, invalidates the reviewed generation.

### 6. Host and implementation boundaries remain narrow

`templateNotice` is carried on tool results so a long-lived host surfaces it
even when boot instructions are stale; `status` remains the read-only polling
view. Pending body contracts and missing fresh policy-bound projection coverage
also trigger it when the raw census reports no new diff.
The product retains five MCP tools and seven skills. This decision adds
no compatibility converter, legacy-contract fallback, Templater execution,
daemon or watcher, new widget, tool, or user-facing configuration option.

## Tradeoffs and consequences

Folder census removes admission friction and gives each changed source a
bounded blast radius, but review may ask more explicit questions than the old
registration path. Anchors and CAS add ledger and locking complexity, but avoid
silently applying answers to changed source bytes. A bounded body grammar is
verifiable and honest, but Markdown outside its supported nodes remains
unclaimed. Controls-only reconcile protects user files, while final approval
still requires the user to confirm the exact digest.

The separate follow-ups are to index this ADR in `docs/decisions/README.md` and
notify the owner of `core/AGENTS.md`; neither is changed by this ADR file.
