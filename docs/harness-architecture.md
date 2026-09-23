# Harness Architecture

Oh My Second Brain is an Obsidian-first convention layer over plain Markdown. Obsidian remains the command center, and the vault remains readable without OMS. The user owns meaning. The agent writes and repairs notes. OMS guides, checks saved bytes, and judges completion. A separate host reviewer judges the approved rubric.

The sequence in this page is a repository sketch. It is not the G002 Excalidraw artifact. Nothing here is a host-smoke result or a product-gate pass. [ADR-014](./decisions/ADR-014-user-owned-contract-completion-harness.md) supersedes [ADR-013](./decisions/ADR-013-folder-sourced-template-contracts.md). [ACKNOWLEDGMENTS](../ACKNOWLEDGMENTS.md) credits Ouroboros and Gajae Code's deep-interview as ideas that were not ported and were not turned into a research claim.

## Authority the harness enforces

The harness does not invent a vault's fields, folders, or personas.

1. `.oms/template-policy.json` version 4 is the approved structure and meaning. The property pool holds type, format, and intent. The always-on default starts empty. An individual template only adds or tightens fields, headings, and criteria.
2. `.oms/taxonomy.json` owns placement and folder and link meaning. An explicit path or folder wins, then template placement, then a question. There is no Inbox fallback.
3. `.obsidian/types.json` is a read-only observation. A type conflict does not replace the approved contract.
4. `.oms/types.json` is the derived `oms.types.v2` projection. It is not semantic authority.

Approved Markdown is exact UTF-8, including BOM and line endings. Managed drafts under `.oms/templates/` stay editable. Local drift does not change the approved snapshot, and guide keeps returning that snapshot. OMS never executes raw Templater, JavaScript, or a private token, and it does not infer a contract from them. Unmanaged frontmatter is preserved and unchecked.

There is no version-3 migration, renderer, note-write, link-apply, or backfill compatibility path.

## Guide, then the agent, then check and complete

Note bytes are not published by a guarded OMS writer.

- **Guide.** Resolve a verified target and return approved Markdown, the effective contract, and the task binding. If the path is not chosen, ask. Do not issue a check task.
- **Agent write or repair.** The agent saves ordinary Markdown with the host's file tools. A save is not completion. Repair stays off unless the user enabled it for post-write or explicit maintenance.
- **Check.** Read the saved note, controls, and declared evidence. Return the machine result and an immutable review request. Refuse an unsaved body and a caller PASS.
- **Separate review.** The host launches another role or conversation with a non-modification instruction. OMS does not launch a model provider or a reviewer daemon.
- **Complete.** Read the same inputs again and combine the machine result with the structured review. Stop if those inputs differ.

A matching task id after a restart only shows that the snapshot bytes are the same. It does not authenticate the caller. A machine pass alone, a self-evaluation, or a bare PASS does not complete the work. Before-and-after agreement covers the evaluation inputs, not the whole vault.

Instruction-only isolation is a valid result when the separate call, the non-modification instruction, and those inputs agree. Installed asset bytes are not launch proof and not enforcement proof. The receipt does not claim that OMS verified independence. Host mechanisms and the fail-open Claude write hook are specified in the [host asset contract](./adapters.md). Codex and Hermes declare no write hook. No hook is a hard save block.

`completion.retryBudget` is the user's finite nonnegative integer, default 2, including 0. The harness does not add a cap of 3. The host owns retry counting. OMS inspects the chain submitted with the request and does not treat a stateless receipt as proof about retries it was not shown. An exhausted budget or a cancellation waits for the user. The contract is not weakened to obtain a pass.

Missing or tampered approved authority stops this evaluation. It does not stop search.

## Config interview

The tool-less `interview` skill owns setup and later contract create, add, change, and update. It asks one question, confirms a free-text interpretation when the question needs it, records what is still undecided, and commits only the user-approved diff by compare-and-swap. `template` is also tool-less: it shapes the contract and does not render a note.

`oms template review --proposals`, `oms template answer`, and `oms template commit` are the leaves. Callers forward the server-returned question and compare-and-swap fields, send the same `proposals` on every call, and do not invent names. Publication writes policy, taxonomy, the projection, and approved managed Markdown. It does not write original sources, Obsidian types, or ordinary notes. Several files in one publish are not claimed to be one atomic commit. A torn or in-progress transaction stops guide, check, and complete. Search continues.

A source or draft edit is not approval. The notice text and its two buttons are fixed in the [host asset contract](./adapters.md). Deferring makes no server call. Confirming offers the interview. A general question, an unknown value, a note error, an unmanaged property, or a search does not start it.

`oms setup` proposes an empty version-4 policy and never modifies notes. It ships no bundled note shapes. Model lifecycle stays on `oms model install|select|waive|status`.

Admission still applies to contract publication and to derived-state repair: verified target, safe paths, the exact approved digest, and current compare-and-swap expectations. Rejection has no side effects. The current-directory fallback cannot admit those mutations. Precedence is in [verified targets](./verified-target.md).

## Retrieval and maintenance

Lexical, vector, HyDE, and typed-axis retrieval include unbound, invalid, and incomplete notes. Search does not write, review, or repair. Managed template sources stay out of ordinary note results. Typed axes fail loudly when the projection is missing, malformed, or stale. Vector, HyDE, and rerank fail loudly when their capability pair is missing or unusable, per ADR-007, rather than returning a fake match.

`status` is read-only and does not stand in for completion. `doctor` diagnoses controls and indexes. Repairs are explicit managed-state operations after admission. Note backfill is not one of them. Projection regeneration uses the same dry-run and exact approved digest as other control publication.

The external runtime journal may store digests and outcomes. It is not validity authority. A failed journal append does not change the verdict.

## Surfaces

The public sets are intentionally different:

- eight skills: `distill`, `doctor`, `interview`, `link`, `search`, `status`, `template`, `write`, with tool-less `interview` and `template`;
- five capability-only local MCP tools: `write`, `search`, `link`, `status`, `doctor`;
- fourteen CLI families, listed only in [the CLI map](./cli-map.md).

Detail capabilities remain `op` and `mode` values under the five tools. `write` is annotated as a write because the interview and contract commit change managed state. `guide`, `check`, and `complete` write no vault bytes. Link's posture is read-only: suggest and check, not apply.

Host adapters differ natively, but they register the same MCP runtime and stamp the selected vault into `oms serve mcp --vault`. That stamp does not change resolution precedence: explicit target, local vault controls, bridge, `OMS_VAULT`, then read-only current-directory fallback.

The runtime server id is `oms`. Qualifying hosts render the local names as `oms_write`, `oms_search`, `oms_link`, `oms_status`, and `oms_doctor`, never `oms_oms_*`. Raw MCP callers use the local names.

The five top-level source directories remain `src/assets`, `src/cli`, `src/kernel`, `src/mcp`, and `src/vendors`. No new top-level source directory and no new MCP tool are part of this harness.
