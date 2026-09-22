---
name: interview
description: Set up or change a vault contract one confirmed question at a time, then commit only the exact approved diff. Not for ordinary note questions.
---

# interview

Run setup and contract create, add, change, and update. This skill has no MCP tool and no GJC or ralplan runtime. Persist through the existing template interview ledger. Do not edit `.oms/template-interview.json` by hand.

## Use when

- Initial contract setup.
- A change to policy, taxonomy placement, template scope, or an approved contract.
- The user chooses `확인하기` on a template-change notice.

## Do not start it for

An unknown note value, a wrong note, a failed check, an unmanaged property, a search, or a general question. Ask and revise those in the normal note flow. Do not score ambiguity or wait for a numeric clarity threshold.

## Before the first question

Read intent that already exists: policy field intent, taxonomy placement and link intent, approved Markdown, and instructions the user already gave. Reuse it. Ask only about a real gap. Do not turn one example into an allowed-value list or a universal rule, and do not preload a vault-specific schema. A new vault starts from an empty default. Model and provider setup stays on the existing setup command.

## One question

Ask one decision at a time, using the server's `next` question. Do not batch questions or invent ids or digests.

```text
write { op: "template", mode: "interview-next" }
```

`oms template review` is the CLI counterpart. Send no other fields. Resume from the returned `next`, `censusDigest`, and `expectedLedgerDigest`. An absent ledger is `expectedLedgerDigest: null`; pass that null. On `TEMPLATE_INTERVIEW_STALE`, call `interview-next` again and discard the old digests.

When existing intent already answers the question, propose that wording for confirmation. Do not submit it silently.

## Free-text confirmation

For a free-text answer, show a compact interpretation before submitting: the decision, the constraints the user stated, and anything still undecided. The user confirms or corrects that interpretation in the same decision. A bare yes/no or an explicit choice needs no second restatement.

```text
write {
  op: "template",
  mode: "interview-answer",
  questionId,
  answer,
  censusDigest,
  expectedLedgerDigest
}
```

`oms template answer` takes those same fields. Do not add a field the response did not return, and do not send `anchorDigest`. If the text does not fit the question, say so and ask once more. Do not guess a legal choice. Record a deferral only when the returned question accepts one. `나중에` on a template notice is host-only and must not call the server. Opening a review again reopens deferred deletion decisions and keeps other confirmed answers.

## Exact diff and approval

`blocked` stops the commit. `unchanged` means there is nothing new to publish. `confirm` still requires the user to approve the exact final diff, including when no questions were left.

Preview with `mode: "commit-contracts"`, the returned `censusDigest` and `expectedLedgerDigest`, and `dryRun: true`. Show the server's proposal and exact `approvalDigest`. Publish only after the user approves that digest:

```text
write {
  op: "template",
  mode: "commit-contracts",
  censusDigest,
  expectedLedgerDigest,
  dryRun: false,
  approvedDigest
}
```

`oms template commit` is the CLI counterpart. Never self-approve. The publish writes policy, taxonomy, the derived projection, and approved managed Markdown. It does not write original sources, Obsidian type files, or ordinary notes. Do not use template create, update, move, remove, or renderer modes.

## Notice

The first display of a selected-source change is exactly `템플릿에 변경이 있습니다`, with exactly `확인하기` and `나중에` and no template name, hash, or change list. `확인하기` starts this interview. It does not write source bytes or block search.

## Surface

`interview-next`, `interview-answer`, and `commit-contracts` are the only template mutations.

Contract meaning enters OMS only through the `proposals` array you supply. It is never derived from a file name or from template syntax, so a source the census discovered stays unbound until you propose what it means. Pass the same `proposals` to `interview-next`, `interview-answer`, and `commit-contracts`: commit rebuilds the interview, and an answer whose question cannot be reproduced is refused rather than silently dropped from the published contract.

Answer with `questionId`, `answer`, `censusDigest`, and `expectedLedgerDigest`. The server binds the question anchor; never send `anchorDigest`.
