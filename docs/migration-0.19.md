# Migrating to 0.19

0.19 replaces the CLI and MCP surface. The fourteen CLI families collapse into seven (`search`, `interview`, `write`, `setup`, `doctor`, `serve`, and the hidden `hook`), and the five MCP tools become four (`write`, `search`, `interview`, `doctor`). The shared skills become six: `write`, `search`, `interview`, `distill`, `setup`, and `doctor`.

A removed 0.18 command family is not an alias. Typing one exits 1 and prints its replacement, for example:

```text
[oms] Command `index` was removed in 0.19. Use `oms doctor sync-embeddings --mode sync|embed|repair`, `oms doctor cleanup`, or `oms doctor status`.
```

The judge, the sealed contract, and the verified-target rules are unchanged. Only the spellings that reach them moved.

## Command map

| 0.18 | 0.19 CLI | 0.19 MCP |
|---|---|---|
| `oms note get` | `oms search --path <note>` | `search` with `path` |
| `oms search query <text>`, `oms search context` | `oms search <text> [--mode ...]`, `oms search --context` | `search` with `op: query` / `op: context` |
| `oms link suggest`, `oms link check` | `oms search --link <note>`, `oms doctor link-check <note>` | `search` with `op: link`, `doctor` with `op: link-check` |
| `oms status`, `oms graph status` | `oms doctor status` (read-only; the report carries the `graph` section) | `doctor` with `op: status` |
| `oms index status [--view status|collections|contexts]` | `oms doctor status --view status|collections|contexts [--index <path>] [--collection <name>]` (read-only; never creates a store) | `search` with `op: index-status` |
| `oms contract doctor`, `oms note audit` | `oms doctor contract`, `oms doctor audit` | `doctor` with `op: validate` / `op: audit` |
| `oms index sync|embed|repair`, `oms index clean`, `oms graph build` | `oms doctor sync-embeddings --mode sync|embed|repair`, `oms doctor cleanup`, `oms doctor build-graph` | `doctor` ops unchanged |
| `oms contract setup|extract|status` | `oms setup`, `oms setup extract`, `oms setup status` | none |
| `oms host ...`, `oms model ...`, `oms package ...`, `oms bridge ...` | `oms setup host ...`, `oms setup model ...`, `oms setup package ...`, `oms setup bridge ...` | none |
| (none) | `oms interview` | `interview` |
| MCP `write` only | `oms write <path>` (content on stdin) | `write` |

## MCP tools

- The `link` tool is gone. Suggest links with `search` and `op: "link"`; check them with `doctor` and `op: "link-check"`.
- The `status` tool is gone. Read health with `doctor` and `op: "status"`. It is read-only and creates no engine store.
- The new `interview` tool continues the interview across calls. `op: questions` lists the open questions with the seal state; `answer`, `confirm`, and `seal` need a verified target and seal only the proposal the owner confirmed. Only the owner loosens a seal, from a terminal.
- Annotations are per tool. Only `search` is annotated read-only; `write`, `interview`, and `doctor` are not. See [the CLI map](./cli-map.md#annotations-are-per-tool).

## CLI write and interview

`oms write <path>` reads the note from stdin and goes through the same write pipeline and judge as the MCP `write` tool. A `cwd`-inferred target is refused, and a violation leaves the file unchanged.

**Breaking: overwriting an existing note needs `ifMatch`.** In 0.18 MCP `write {path, content}` silently replaced an existing note. In 0.19 it is refused with `WRITE_IF_MATCH_REQUIRED` and nothing is written. Pass the note's current `sha256:` revision as `ifMatch` (`--if-match` on the CLI); a previous receipt or `check: true` (`--check`) reports it. A stale revision returns the retryable `WRITE_TARGET_CHANGED`. Creating a new note needs no `ifMatch`; sending one for a note that does not exist returns the retryable `WRITE_TARGET_ABSENT`.

The write result grows from `{ok, path, missingDefaults}` to the receipt `{ok, path, revision, contractRevision, index: {keyword, vector}, conformed, missingDefaults}`.

`oms interview` is the interactive interview. Like `oms setup`, it refuses to run without a TTY or under `OMS_NON_INTERACTIVE=1`.

## Hosts

Re-run `oms setup host sync` after upgrading so installed host assets pick up the six skills and the four tools. The Claude and Codex plugin manifests at the repository root already point at the new skill set.
