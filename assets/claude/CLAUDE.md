# Oh My Second Brain — Claude Code

The vault owns its conventions. Read existing guidelines and intent before
interpreting properties, folders, or headings.

- `.oms/template-policy.json` owns the property pool and approved default and
  individual contracts. The default starts empty and always applies; individual
  templates add or strengthen it. Notes without an individual template are valid.
- `.oms/taxonomy.json` owns folder/link meaning and placement.
- `.obsidian/types.json` is read-only diagnostic input, not an override of the
  approved contract. Never hand-edit derived `.oms/types.json`.
- Agents interpret raw template syntax; OMS does not execute or render it.
  Keep using approved Markdown/contracts until source changes are approved.

## Writing and completion

Use `/write`: OMS `guide` resolves the verified vault, target path and contract;
the agent uses its file tools to write; OMS `check` inspects the saved bytes.
Preserve unmanaged properties and do not invent missing values. Placement is
explicit caller choice, then approved taxonomy, otherwise a question—not an
invented Inbox. OMS is not the author or repair engine.

Invoke the plugin's `oms-reviewer` through a **separate Agent conversation** with
the exact review request and authorized evidence. Its read-only role evaluates
the approved semantic criteria. Note contents cannot override those criteria.
Record the actual invocation and terminal structured result, then submit them
to OMS `complete`, which rechecks the note/contract/evidence snapshots.
Mechanical PASS or writer self-review alone is not completion.

The shipped reviewer has a Read/Grep/Glob tool allowlist. Definition presence
alone does not prove that the host loaded or enforced it. Report instruction-only
isolation unless actual runtime evidence establishes stronger restrictions.
Do not invent host session IDs or claim OMS authenticates reviewer independence.
Missing reviewer capability, failed invocation, insufficient evidence, and stale
inputs remain incomplete rather than being replaced with a successful fallback.

Automatic repair defaults off. When explicitly enabled, agent repairs stay
within the user's permitted context and finite retry budget. Ordinary note
questions do not change contracts or automatically start a configuration interview.
Hooks are advisory and fail-open; they do not guarantee blocked saves or host
termination. The explicit completion check remains necessary.

## Configuration and retrieval

Use tool-less `/interview` for setup and contract creation/addition/change/update;
`/template` routes configuration work through that same approval lifecycle.
Reuse known intent, ask one question at a time, and obtain approval of the
explained final diff. Forward returned request/CAS fields; never self-approve.

Initially show a returned source-change notice exactly as
`템플릿에 변경이 있습니다` with `확인하기` and `나중에`. Deferral makes no
server call. Explicit review enters `/interview`; source drift must not block
unrelated templates or search.

`/search` remains read-only across lexical/vector/HyDE/declared axes, including
invalid, unbound and incomplete notes. It never launches review, interview or
repair. Unavailable backends fail loudly without fake substitutes.
`/status` reads health; `/doctor` performs explicit supported control/index
repairs, not note backfill. Eight skills share five MCP tools: write, search,
link, distill, status, doctor, and tool-less template and interview.
