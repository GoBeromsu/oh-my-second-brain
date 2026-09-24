# Oh My Second Brain — Claude Code

The vault owns its conventions. Read existing guidelines and intent before
interpreting properties, folders, or headings.

- `.oms/template-policy.json` is the published contract. Its version-5 document
  owns the property pool, the common contract, and each explicitly registered
  template. The common contract always applies and has no Markdown file of its
  own; a registration inherits it and may also relax what the user approved.
  Notes with no registered template are valid under the common contract alone.
- `.oms/taxonomy.json` owns folder/link meaning and placement.
- `.obsidian/types.json` is read-only diagnostic input, not an override of the
  published contract. `.oms/types.json` is a historical version-4 projection:
  version 5 neither derives nor reads it, and nothing regenerates it.
- Agents interpret raw template syntax; OMS does not execute or render it. A
  registered Markdown source stays the user's own file: OMS records its path and
  content hash and never rewrites, copies, or manages a shadow snapshot.

## Writing and checking

Use `/write`: OMS `guide` resolves the verified vault, target path and contract
and returns a session locator; the agent uses its file tools to write; OMS
`check` inspects the saved bytes through that locator. Preserve unmanaged
properties and do not invent missing values. Placement is explicit caller
choice, then approved taxonomy, otherwise a question—not an invented Inbox.
OMS is not the author or repair engine.

`check` reports declared properties and headings and returns
`semantic: "not-evaluated"`. It is a structural result, not a judgement that the
note is worth keeping. There is no OMS completion call and no reviewer
handshake: you decide whether the note is good, and you own the repair. Read a
reported violation, fix the file with your own tools, and run `check` again on
the new bytes. Never weaken the contract to pass.

Automatic repair defaults off; `agentRepair` lives in the portable
`.oms/settings.json`, not in the contract. When the user enables it, repairs stay
within the contexts they permitted. OMS declares no retry budget and counts no
attempts: when you cannot fix a violation from what the user gave you, ask them
rather than retrying blindly. Ordinary note
questions do not change contracts or automatically start a configuration interview.
Hooks are advisory and fail-open; they do not guarantee blocked saves or host
termination. An explicit `check` on the saved bytes remains necessary.

## Configuration and retrieval

Use tool-less `/interview` for setup and contract creation/addition/change/update;
`/template` routes configuration work through that same approval lifecycle.
Reuse known intent, ask one question at a time, and obtain approval of the
explained final document. OMS keeps no interview state: agree the decisions in
conversation, write the version-5 contract document, and publish it with
`oms template publish`, which previews without `--yes` and compare-and-swaps
against the exact bytes now on disk. Never self-approve.

Initially show a returned source-change notice exactly as
`템플릿에 변경이 있습니다` with `확인하기` and `나중에`. Deferral makes no
server call. Explicit review runs `review-sources`; a changed source is then
acknowledged with its live digest, or relinked only when the original file is
genuinely gone and the user spells out the candidate path. A changed hash is
evidence of drift, never approval, and must not block unrelated templates or
search.

`/search` remains read-only across lexical/vector/HyDE/declared axes, including
invalid, unbound and incomplete notes. It never launches review, interview or
repair. Unavailable backends fail loudly without fake substitutes.
`/status` reads health; `/doctor` performs explicit supported control/index
repairs, not note backfill. Eight skills share five MCP tools: write, search,
link, distill, status, doctor, and tool-less template and interview.
