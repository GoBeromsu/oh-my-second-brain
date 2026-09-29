---
name: interview
description: Continue the vault interview across calls — list the open questions, record the owner's answers, and seal only the proposal the owner confirmed.
mcp_tool: interview
mcp_args: {}
---

# interview

Continue the vault interview where it stopped. Answers are kept in the interview log beside the sealed store, so each call picks up from the last one. The agent never answers a question for the owner and never confirms a seal the owner did not agree to.

```text
/interview [--reask]
```

MCP `interview { op?, answers?, proposed?, reask? }`. `op` defaults to `questions`, which is read-only. `answer`, `confirm`, and `seal` record to the log and need a verified vault target; on a vault inferred from the working directory they return `{ok: false, status: "rejected", rejection}` and write nothing.

1. `op: "questions"` returns the vault, the contract posture, and a `status`. The questions cover folders and properties only; templates scaffold new notes from the template folder and are never sealed.
2. Ask the owner each listed question, then `op: "answer"` with `answers` keyed by question id. Earlier answers stay; only unanswered questions come back.
3. When every question is answered, the status is `proposed` with a `proposed` digest and a preview in `notes`. Show the owner the preview, including any `CONTRACT_LEGACY_TEMPLATES_DROPPED` line, which means templates an older seal held are not carried forward.
4. Only when the owner agrees, `op: "confirm"` with that `proposed` digest, then `op: "seal"`.

Statuses:

- `questions`: `questions` lists `{id, prompt, kind, choices?, default?}` and `notes` holds interview lines worth showing the owner. `drift` lists earlier answers dropped because their question changed.
- `proposed`: every question is answered; confirm with the owner before `confirm` and `seal`.
- `sealed`: the confirmed contract is sealed.
- `loosening`: the sealed contract would loosen. `changes` names each field and kind of change, never a value. Only the owner can loosen a contract, by running `oms interview` in a terminal.
- `refused`: `reasons` names why the interview cannot run. Tell the owner to run `oms doctor contract`, then `oms interview` in a terminal.
- `rejected`: `rejection.code` says why. `INTERVIEW_CONFIRM_REQUIRED` and `INTERVIEW_CONFIRM_STALE` mean the owner has not confirmed the current proposal. `INTERVIEW_SEAL_LOCK_STALE` means an earlier seal left its lock; the tool never reclaims it, and the owner runs `oms interview` in a terminal. `CONTRACT_SEAL_BUSY` is retryable.

`reask: true` asks again about items declined at an earlier seal.

`oms interview` is the owner's interactive terminal interview. It continues from the same log, `--restart` starts over, it needs a real terminal, refuses `OMS_NON_INTERACTIVE=1`, and has full authority, including loosening. Never run it on the owner's behalf.

Never read, list, or edit `~/.oms` or any sealed contract file. The values the owner gives are part of the hidden contract; do not repeat them into notes, messages to others, or memory.

The surface is four MCP tools (write, search, interview, doctor) and six skills.
