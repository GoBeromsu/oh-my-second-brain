# Architecture

Oh My Second Brain is an Obsidian-first vault integration. It keeps the vault as plain Markdown the user owns, and it separates that meaning from generated runtime data. Obsidian remains usable when OMS is absent. OMS does not become the note store, and one example does not become a required rule.

These pages record the approved architecture. They are not a host-smoke result and not a product-gate pass. The text figure below is a repository sketch. It is not the G002 Excalidraw artifact, which has to be drawn in the bound vault and checked by save, reload, and render.

## Authorities and derived state

```text
oms setup (interactive, user only)
        │  interviews folders, property pool, and templates together
        ▼
sealed contract            ~/.oms/vaults/<vault-id>/   outside the vault
        │
        ├── .oms/settings.json      the only OMS file inside the vault
        ├── templateFolder/*.md     the user's own templates, recorded by path and hash
        └── .obsidian/types.json    read-only observation, not the contract
```

The sealed contract is the only structural authority. It holds three axes: folders (meaning and search exclusion), the property pool (meaning, Obsidian type, required flag, and allowed, fixed, pattern, or range rules), and templates (source path, content hash, optional apply folder, and the properties, narrowed rules, and headings each one requires). An axis the user did not seal stays open. OMS does not hardcode property names, folder names, personas, or the meaning of a heading, and it has no Inbox fallback.

The contract is stored per machine outside the vault, so an agent working inside the vault cannot read or edit it. `.oms/settings.json` carries `version`, `vaultId`, `templateFolder`, `embedding`, and `agentRepair`; unknown keys, including the former `templateRoots`, are refused. Any other entry under `.oms/` is ignored and reported by `oms contract doctor` as an unexpected control file.

A template stays the user's own Markdown file. Sealing records what it declares; OMS never rewrites, copies, snapshots, or applies it. A changed hash is drift evidence, not approval, identity, or authentication. OMS does not parse or execute Templater, JavaScript, or a private token language.

`.obsidian/types.json` is a read-only observation. OMS does not write the file and it never overrides the seal.

The vault contract is recorded in ADR-007, which replaces the former ADR-013 through ADR-016. [ACKNOWLEDGMENTS](../ACKNOWLEDGMENTS.md) records the debt to Ouroboros for an explicit contract and a split between writing and evaluation, and to Gajae Code's deep-interview for one confirmed question at a time. Neither credit is a code port or a measured research claim.

## One judge for every write

The agent writes the whole note. One judge decides every write against the seal, in a fixed order: base path rules (control paths, unsafe paths, paths outside the vault, YAML syntax), then the seal's readability, then folders, then properties, then the selected template's apply folder, then the template axis.

- MCP `write {path, content, template?}` judges the note and saves it atomically only when it is allowed. Unknown or missing input keys are refused before any judgement.
- In Claude Code, native Write, Edit, MultiEdit, and NotebookEdit inside the configured vault reach the same judge through the guard hook, which runs `oms hook pre`. A violation denies the tool call. When the judge cannot run, the call is allowed with a warning and the transport failure is recorded for `oms contract doctor`.
- The guard also denies reads and writes under `~/.oms/`, and Grep or Glob patterns that name it.
- Codex and Hermes have no write hook; their notes are judged only when written through MCP `write`.

A denial leaves the file unchanged and returns only `{field, kind}` violations and one guidance command, never a rule value, a store path, or the contract body. A vault with no seal on this machine is not judged. When this machine holds seal evidence that no longer matches the vault, writes are refused as `contract-unreadable` until the user runs `oms setup` again.

Structural results do not evaluate the note's semantic quality. An allowed write is not a completion verdict. OMS has no completion operation and no reviewer handshake; deciding whether a note is worth keeping and repairing it belongs to the user and the agent. Note text is untrusted data, not new instructions. OMS adds no model provider, reviewer daemon, or repair workflow. The engine store, graph cache, and node index live outside the vault and are rebuildable. See [conventions](./conventions.md).

## Drift, diagnosis, and search

`oms contract status` reports each sealed template as `active`, `drift`, or `missing` against the live file. Drift is reported, never re-sealed silently. `oms contract doctor` diagnoses the seal, stale locks, orphaned generations, unexpected control files, and hook transport failures, and exits 1 when unhealthy. `--fix` only re-indexes a moved or unindexed vault; every other broken seal is recovered by running `oms setup` again. `oms note audit` judges existing notes and reports `{path, field, kind}` entries without rewriting them.

Search is independent of the contract. Lexical, vector, HyDE, and typed-axis queries include notes that would fail it, and a missing or damaged contract does not stop search. Sealed template sources and folders marked for search exclusion stay out of ordinary note results. Vector, HyDE, and rerank requests fail loudly when their provider and model pair is missing or unusable. Those failures are not replaced with an empty success or another backend. That is the ADR-005 boundary. Search does not write notes and does not repair anything.

`status` reports observation. `doctor` diagnoses the contract and indexes. Its index repairs are explicit managed-state repairs after verified-target admission. Note backfill is not a repair. Target precedence and admission are in [verified targets](./verified-target.md).

## Public surfaces

The CLI does not require a host. The three public sets stay independent:

| Set | What it is |
| --- | --- |
| Six skills | `distill`, `doctor`, `link`, `search`, `status`, `write`. Host workflows. `distill` is tool-less. |
| Five MCP tools | `write`, `search`, `link`, `status`, `doctor`, from `oms serve mcp`. A subset of the skills. |
| Fourteen CLI families | `setup`, `contract`, `note`, `link`, `bridge`, `search`, `index`, `graph`, `host`, `package`, `model`, `serve`, `hook`, `status`. Not the skill list and not the tool list. |

Sealing has no MCP operation and no skill. Leaves, discriminators, and removed operations are only in [the CLI map](./cli-map.md). `bridge` is the repository-to-vault target. `link` suggests and checks note wikilinks and does not apply them. `package update` does not sync hosts. `oms serve mcp` and `oms serve http` do not create a vault engine store by starting.

### MCP namespace boundary

The MCP server id is `oms`. Local tool names are `write`, `search`, `link`, `status`, and `doctor`. Qualifying hosts therefore display `oms_write`, `oms_search`, `oms_link`, `oms_status`, and `oms_doctor` exactly once, never `oms_oms_*`. Raw MCP clients call the local names.

Directly under `src`, the five top-level entries are still assets, cli, kernel, mcp, and vendors. There is no sixth MCP tool. The skill, tool, and command names above are the approved public surface. Retired note, link, and template operations have no compatibility path.

See [conventions](./conventions.md) for vault data and [installation](./install.md) for host setup.
