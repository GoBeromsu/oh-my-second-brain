# Harness Architecture

Oh My Second Brain is an Obsidian-first convention layer over plain Markdown. Obsidian remains the command center, and the vault remains readable without OMS. The user owns meaning. The agent writes and repairs notes. OMS guides one note path at a time and checks saved bytes; the user and agent decide whether a note is worth keeping and repair it when needed.

The sequence in this page is a repository sketch. It is not the G002 Excalidraw artifact. Nothing here is a host-smoke result or a product-gate pass. Template contracts are recorded in [ADR-007](./decisions/ADR-007-template-contract-sealed-two-layer.md) (Accepted; implementation in progress), which replaces the former ADR-013 through ADR-016; until it is implemented, the code still follows the former ADR-015 version-5 policy. [ACKNOWLEDGMENTS](../ACKNOWLEDGMENTS.md) credits Ouroboros and Gajae Code's deep-interview as ideas that were not ported and were not turned into a research claim.

## Authority the harness enforces

The harness does not invent a vault's fields, folders, or personas.

1. `.oms/template-policy.json` version 5 is the only structural authority. Its property pool holds declared property definitions, its always-on common contract has no Markdown file of its own and holds exactly what the published document declares, and each template is explicitly registered. A registration inherits the common contract and may add, tighten, or relax it where the user approved that relaxation. A value set is closed only when the document declares `valuePolicy: "closed"`; `allowedValues` alone is a suggestion.
2. `.oms/taxonomy.json` owns placement and folder and link meaning. An explicit path or folder wins, then template placement, then a question. There is no Inbox fallback.
3. `.obsidian/types.json` is a read-only observation. A type conflict does not replace the approved contract.
4. `.oms/types.json` is a historical version-4 projection. Version 5 neither reads nor derives it, and nothing regenerates it.

Each registration records the path and content hash of the user's own Markdown source. OMS never rewrites, copies, or snapshots that source, and stores no approved Markdown bytes. A changed hash is drift evidence, not approval, identity, or authentication. OMS never executes raw Templater, JavaScript, or a private token, and it does not infer a contract from them. Unmanaged frontmatter is preserved and unchecked.

Historical version-3 and version-4 policies remain readable. A mutating selection migrates one in place only when its recorded evidence is proved and representable without changing its meaning; held or unproved history is reported as `review-required`, never overwritten.

## Guide, then the agent, then check

Note bytes are not published by a guarded OMS writer.

- **Guide.** Select the contract for one explicit note path, reserve a vault connection, open a minimal session, and return its locator with the effective contract.
- **Agent write or repair.** The agent saves ordinary Markdown with the host's file tools. A save is not completion. Repair stays off unless the user enabled it for post-write or explicit maintenance.
- **Check.** Read the saved bytes through that locator and report declared properties and headings with `semantic: "not-evaluated"`.

OMS has no completion call or reviewer protocol, and no reviewer role is shipped or registered. It neither issues review requests nor binds tasks, accepts caller PASS values, or keeps completion evidence. The agent and user retain responsibility for judging, keeping, and repairing ordinary notes.

Installed asset bytes are not launch proof and not enforcement proof. Host mechanisms and the fail-open Claude write hook are specified in the [host asset contract](./adapters.md). Codex and Hermes declare no write hook. No hook is a hard save block.

Missing or unreadable authority is reported distinctly from absent or empty control state. It stops the affected typed diagnosis but does not stop search, which remains available with a named reason.

## Config interview

The tool-less `interview` skill agrees contract decisions with the user, writes an explicit version-5 policy, and publishes it. `template` is also tool-less: it shapes the contract and does not render a note.

Contract publication uses `oms template publish --policy <file.json> --transaction-id <uuid> [--yes]` or MCP `write` with `op: "template"` and `mode: "publish-contract"`. Without `--yes`, publication previews; with it, the compare-and-swap is against the exact policy bytes now on disk, so a valid hand-edited policy remains revisable. The output is the policy and one history record, never original sources, Obsidian types, ordinary notes, taxonomy, or a projection. The first publication is revision 0, and OMS keeps no interview ledger, question id, census digest, or server-issued approval digest.

Every mutating template mode requires an explicit transaction id. `review-sources` is read-only and reports drifted, missing, unreadable, and held registrations. `acknowledge-source` requires the live reviewed digest and advances only the recorded hash; `relink-source` requires a genuinely missing original and the exact candidate path the user supplies. A source edit is not approval.

`oms setup` connects the vault after the user approves the digest printed by `--dry-run`: it writes portable `.oms/settings.json` identity and the host connection, and can select a model in the same pass. It publishes no contract and ships no bundled note shapes. `.oms/settings.json` includes the vault UUID; `.oms/history/contracts/<revision>.json` records publication, source acknowledgment, and relink history. Model lifecycle stays on `oms model install|select|waive|status`.

Admission still applies to contract publication and other mutations: verified target, safe paths, current compare-and-swap expectations, and explicit transaction id. Rejection has no side effects. The current-directory fallback cannot admit those mutations. Precedence is in [verified targets](./verified-target.md).

## Retrieval and maintenance

Lexical, vector, HyDE, and typed-axis retrieval include unbound, invalid, and incomplete notes. Search does not write or repair. Registered template sources stay out of ordinary note results. Typed axes come from the version-5 policy and `.oms/taxonomy.json`; a missing or unreadable contract fails an affected axis loudly with a named reason. Vector, HyDE, and rerank fail loudly when their capability pair is missing or unusable, per ADR-005, rather than returning a fake match.

`status` is read-only. `doctor`, together with `validate`, diagnoses policy, portable settings, held registrations, source state, and indexes. An unreadable control has its own state, including `CONTRACT_POLICY_UNREADABLE`, `TEMPLATE_POLICY_UNREADABLE`, and `TEMPLATE_TAXONOMY_UNREADABLE`; publication refuses rather than overwriting it. Repairs are explicit managed-state operations after admission. Note backfill is not one of them. The engine store, graph cache, and node index are outside the vault and rebuildable.

The external runtime journal may store digests and outcomes. It is not validity authority. A failed journal append does not change the verdict.

## Surfaces

The public sets are intentionally different:

- eight skills: `distill`, `doctor`, `interview`, `link`, `search`, `status`, `template`, `write`, with tool-less `interview` and `template`;
- five capability-only local MCP tools: `write`, `search`, `link`, `status`, `doctor`;
- fourteen CLI families, listed only in [the CLI map](./cli-map.md).

Detail capabilities remain `op` and `mode` values under the five tools. `write` is annotated as a write because contract publication changes managed state. `guide` and `check` do not write note bytes. Link's posture is read-only: suggest and check, not apply.

Host adapters differ natively, but they register the same MCP runtime and stamp the selected vault into `oms serve mcp --vault`. That stamp does not change resolution precedence: explicit target, local vault controls, bridge, `OMS_VAULT`, then read-only current-directory fallback.

The runtime server id is `oms`. Qualifying hosts render the local names as `oms_write`, `oms_search`, `oms_link`, `oms_status`, and `oms_doctor`, never `oms_oms_*`. Raw MCP callers use the local names.

The five top-level source directories remain `src/assets`, `src/cli`, `src/kernel`, `src/mcp`, and `src/vendors`. No new top-level source directory and no new MCP tool are part of this harness.
