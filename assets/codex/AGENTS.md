# Oh My Second Brain Convention Shim — Codex

<!-- Append this block to a project's AGENTS.md to activate Oh My Second Brain conventions in Codex. -->

## Vault authority

The vault owns its guidelines and `.oms/` policy. Reuse that intent rather than
assigning product-wide meaning to a field, folder, or heading.

- `.oms/template-policy.json` owns the shared property pool, always-on default
  contract (initially empty), and individual additive contracts. An individual
  template is optional; it cannot weaken the default.
- `.oms/taxonomy.json` owns folder/link meaning and placement.
- `.obsidian/types.json` is read-only diagnostic input. OMS-approved contracts
  govern checks. `.oms/types.json` is derived and must never be hand-edited.
- Agents interpret template syntax. OMS neither renders templates nor writes
  ordinary notes. Source drift retains the last approved snapshot until approval.

## Write, review, complete

Use `$oms-write`: obtain OMS `guide`, write with host file tools to the verified
target, run `check`, invoke a separate reviewer, and submit the result to
`complete`. OMS checks actual disk bytes and bound contract/evidence snapshots.
Preserve undeclared properties; ask rather than invent unknown values. Choose
placement explicitly or from approved taxonomy, otherwise ask. Never invent an
Inbox or require individual-template registration for every note.

Use a **fresh Codex subagent conversation**, optionally the installed custom
`oms-reviewer` role when actually discovered. Pass the returned review request,
authorized evidence and non-mutation instructions. A generic separate subagent
is legitimate when custom-role discovery is unavailable; writer self-review is
not. Capture the real invocation and terminal per-criterion verdicts.

The role's `sandbox_mode = "read-only"` is a requested filesystem posture, not
proof of effective runtime restrictions or a boundary on inherited MCP tools.
An empty `mcp_servers` table does not establish that inherited servers are off.
Report instruction-only unless observed enforcement supports a stronger claim.
Do not manufacture host IDs, tool-denial evidence, or an independence certificate.
If no separate invocation is possible, completion remains incomplete.

Mechanical success alone is not completion. Missing evidence, failed review,
or changed snapshots require recovery and fresh evaluation—not self-PASS.
Automatic repair defaults off, and an enabled repair remains agent-owned,
context-scoped and bounded by the user's retry budget. Ordinary note questions
must not silently change the contract.

## Configuration and read-only work

Use tool-less `$oms-interview` for setup and contract creation/addition/change/
update. `$oms-template` routes these tasks through the same lifecycle. Read known
intent first, ask one question at a time, and obtain explicit approval of the
explained final diff. Forward returned request/CAS values; never self-approve.

Initially display a returned source-change notice exactly as
`템플릿에 변경이 있습니다` with `확인하기` and `나중에`. Deferral is host-only,
with no server call or ledger mutation. Explicit review enters the interview
skill; unrelated templates and search stay available.

`$oms-search` is read-only and includes invalid, unbound and incomplete notes;
it must not start validation, repair or interview. Preserve lexical/vector/HyDE/
axis behavior and fail loudly when the requested backend is unavailable.
`$oms-status` reads health; `$oms-doctor` handles explicit supported control/index
repairs, not ordinary-note backfill. Codex installs eight shared skills: write,
search, link, distill, status, doctor, and tool-less template and interview.
