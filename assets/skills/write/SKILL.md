---
name: write
description: Guide a vault note, then check the file the agent saved against its contract.
mcp_tool: write
mcp_args:
  op: "guide"
  notePath: "$1"
---

# write

The user owns meaning. The agent writes the note. OMS guides and checks; it does not write note bytes and does not judge whether the writing is good. `guide` and `check` do not write vault bytes and do not render a template into a note.

```text
/write <note-path> [template-id]
```

Document reads stay on `search { op: "get-document" }`. Approved CLI names are `oms note guide|check|audit|get`.

## Guide

```text
write { op: "guide", notePath, templateId }
```

For the default contract only, omit `templateId` or pass null. Never send `""`. An unbound note is normal. Take ids from `search { op: "templates" }`; never guess one. `guide` has no folder argument. Fix the path first: an explicit path, otherwise the taxonomy placement, otherwise ask. There is no Inbox fallback. If the path is not fixed, guide asks and does not issue a check task. Settle that in ordinary conversation. Switch to `/interview` only when the user is changing placement policy or the contract itself.

Use the returned approved Markdown, effective contract, and task binding. Pass that binding back unchanged on check. Do not invent digests or extra field names.

## Agent write

Write the vault file with the host's file tools, following the approved Markdown and contract. Preserve unmanaged frontmatter. Do not insert guessed required values, and do not weaken the contract so the note will pass. The saved note is ordinary Markdown. Leave Templater or other source syntax in the source; do not ask OMS to execute it. A saved file is not a completed task. An incomplete note remains searchable.

## Check

```text
write { op: "check" }
```

Repeat the task binding from guide. OMS reads the saved note and the approved controls and reports declared frontmatter fields and headings. Do not send an unsaved body or a caller PASS. Check is structural: it reports what the saved bytes do and do not satisfy, and it never issues a completion verdict.

Source drift is reported for that template; guide and check still use the last approved contract. Other templates and search continue. Stop this check while a contract transaction is in progress. A damaged policy is unverifiable, not an empty contract.

## Repair

Agent repair is off unless the user policy sets `agentRepair.enabled` and names post-write or explicit maintenance. A search or check call does not grant edit rights. Stay inside the explicit note scope. `completion.retryBudget` is the user's finite nonnegative integer, default 2, and 0 is allowed. Do not apply a separate cap. The host counts attempts. Do not guess missing values or weaken the contract to clear a failure. An exhausted budget or a cancellation waits for the user.

## Notice

A `templateNotice` uses the first display `템플릿에 변경이 있습니다` and exactly `확인하기` and `나중에`, with no template name, hash, or change list. `나중에` is host-only. `확인하기` offers `/interview` and does not write source bytes or block search. `templateNotice.next` is a mode hint, not a CallToolRequest: do not replay it as `interview-next`.

## Surface

The write operations are `guide`, `check`, and `template`. Note creation, appending, updating, backfilling, and completion do not exist: the agent writes the note, OMS inspects what was saved, and judging whether the note is good stays with the user and the agent. Pass the task binding exactly as `guide` returned it; do not invent field names. A note with no template omits `templateId` rather than sending an empty string.
