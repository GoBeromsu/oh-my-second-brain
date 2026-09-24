---
name: interview
description: Agree the vault contract with the user one confirmed decision at a time, then publish exactly the revision they approved. Not for ordinary note questions.
---

# interview

Set up a contract, change one, or review a changed source. The contract is the explicit document at `.oms/template-policy.json`. OMS holds no interview state: you carry the conversation, you write the document, and you publish it. Do not hand-edit the published policy; publish a revision.

## Use when

- Initial contract setup, after `oms setup` has published the vault settings.
- A change to the property pool, the common contract, a registration, or taxonomy placement.
- The user chooses `확인하기` on a template-change notice.

## Do not start it for

An unknown note value, a wrong note, a failed check, an unmanaged property, a search, or a general question. Ask and revise those in the normal note flow. Do not score ambiguity or wait for a numeric clarity threshold.

## Before the first question

Read intent that already exists: the published property intent, taxonomy placement, the user's own template sources, and instructions the user already gave. Reuse it. Ask only about a real gap. Do not turn one example into an allowed-value list or a universal rule, and do not preload a vault-specific schema. A new vault starts from an empty common contract. Model and provider setup stays on `oms setup`.

## One decision at a time

Ask one decision, in ordinary conversation. Do not batch questions. For a free-text answer, show a compact interpretation before you write it into the document: the decision, the constraints the user stated, and anything still undecided. The user confirms or corrects that interpretation in the same decision. A bare yes/no or an explicit choice needs no second restatement.

Contract meaning enters OMS only as the document you publish. It is never derived from a file name or from template syntax, so a source you discovered stays unregistered until the user says what it means.

## Write the revision

Start from the published contract and change only what was decided. `revision` must be the current revision plus one. Each registration names the user's own source file, its identity, and the exact SHA of the bytes on disk. A closed value list requires `valuePolicy: "closed"`; a list without it stays a suggestion.

## Preview, then publish

```text
write {
  op: "template",
  mode: "publish-contract",
  policy,
  transactionId
}
```

Without `confirmed`, publish returns the revision and the added, removed, and changed registrations, and writes nothing. Show that to the user. Publish only after they approve it:

```text
write {
  op: "template",
  mode: "publish-contract",
  policy,
  transactionId,
  confirmed: true
}
```

`oms template publish --policy <file.json> --transaction-id <uuid> [--yes]` is the CLI counterpart. Never self-approve. The publish writes the policy and one history record. It does not write template sources, Obsidian type files, or ordinary notes. A declared source SHA that is not the live one stops the publication before any byte moves.

## Changed sources

A changed source does not change the contract.

```text
write { op: "template", mode: "review-sources" }
```

Report what drifted. If the user accepts the new bytes as the same contract, acknowledge them with `mode: "acknowledge-source"`, the `reviewedDigest` review returned, a `transactionId`, and `confirmed: true`; only the SHA moves. If the source moved, use `mode: "relink-source"` with the explicit `candidatePath`; the original must be genuinely missing, and matching bytes are evidence, never permission. If the change means the contract itself should change, publish a revision instead.

## Notice

The first display of a changed source is exactly `템플릿에 변경이 있습니다`, with exactly `확인하기` and `나중에` and no template name, hash, or change list. `확인하기` starts this skill. `나중에` is host-only and must not call the server. The notice writes no source bytes and does not block search.

## Surface

`publish-contract`, `review-sources`, `acknowledge-source`, and `relink-source` are the only template mutations. Each takes an explicit `transactionId` and publishes at most one revision. There is no interview ledger, no question id, no census digest, and no server-issued approval digest to replay.
