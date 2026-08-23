# Verified-Target Writes

Reading a vault is safe from anywhere. Writing is not. If an MCP server boots in `~/Documents` and an agent asks it to capture a note, "wherever the process happens to be" is the wrong answer. Oh My Second Brain's write surface therefore refuses to guess: a note is persisted only into a vault that was resolved from a trusted source, and only after the note that landed on disk has been read back and re-checked.

This page describes the write kernel, the global vault registry it leans on, and every rejection it can return. Read tools and CLI read commands (`audit`, `doctor`, `lint`, semantic search) are unchanged and still run anywhere.

## The write loop

Every `write` call runs the same four phases.

**1. Prepare.** Resolve the target vault and its resolution source, load the active ontology, plan the note path (explicit `notePath`, or concept plus folder plus filename), and evaluate the concept contract against the frontmatter you supplied.

**2. Write Attempt.** Render the staged note in memory: frontmatter plus body, exactly as the file will hold it. Nothing touches disk yet.

**3. Evaluation.** Two gates. Before persisting, the staged render is re-parsed and re-checked against the concept contract, which catches values that don't survive the render unchanged. After persisting, the file is read back off disk, the contract runs again on the persisted frontmatter, and the persisted body is compared against what was staged.

**4. Receipt.** A write that clears both gates returns a receipt naming the vault, the resolution source, and the note path. No receipt, no persisted note.

### Admission Rules vs Acceptance Criteria

The gates are split by when they run and what they protect.

| | Admission Rules | Acceptance Criteria |
| --- | --- | --- |
| When | Before any disk mutation | Pre-persist on the staged render, post-persist on the file |
| Checks | Target verification, path safety, mode preconditions, overwrite safety, concept binding | Frontmatter against the concept contract, body content and intent, post-write read-back |
| Failure means | Zero files created or modified | Pre-persist: nothing written. Post-persist: the file is left in place, never auto-deleted |

Admission answers "may I write?". Acceptance answers "did it come out right?". Splitting them is what guarantees a refusal never leaves a half-written note behind.

Concretely, admission verifies:

- **Target** the vault came from a trusted resolution source, and a globally registered vault still holds a `.oms` ontology.
- **Path** the note path is vault-relative, ends in `.md`, stays inside the vault, and avoids hidden or internal folders.
- **Mode** `append` and `update` carry a `notePath`; `update` carries frontmatter, a body, or both; `create` carries a body.
- **Overwrite** `create` refuses an existing note; `append` and `update` refuse a missing one.
- **Binding** for `append` and `update`, the note path resolves to a folder bound to a concept in `taxonomy.yaml`. A `create` that matches no binding isn't rejected at all: it comes back as an `inbox` routing plan instead.

Acceptance verifies:

- The frontmatter satisfies the concept's required fields, types, and declared intent.
- The staged render survives round-tripping without dropping or mangling contract fields.
- The staged body isn't empty.
- The persisted file, re-read from disk, still satisfies the contract and contains the intended body.

## The global vault registry

`~/.oms/config.yaml` remembers which vault is yours, so an MCP server started outside a vault still has a verified target.

```yaml
version: 1
vault: /Users/you/Obsidian/second-brain
```

Two fields, both required in practice:

- `version` an integer, currently `1`. Defaults to `1` when absent.
- `vault` an absolute path, or a `~/...` path that gets expanded at read time. A bare relative value like `../notes` is rejected loudly, because it would resolve against whatever directory the process started in, which is the exact bug this file exists to prevent.

A missing file is fine and simply means "no global target". A file that exists but is malformed (bad YAML, not a mapping, missing `vault`, relative `vault`) is a hard error naming the config path and telling you to run `oms setup`.

**Who writes it:**

- `oms setup` registers the vault it set up, overwriting any previous entry. This is the explicit "this is my vault" command.
- `oms install --vault <path>` registers that vault the same way.
- `oms install` without `--vault` backfills from `OMS_VAULT` when that variable points at a real directory, and only when no config exists yet. It never overwrites an existing entry, not even a corrupt one.

Registry write-back is never fatal. If it fails, you get an `[oms] warning:` line on stderr and the command continues.

There is one primary vault. Multiple registered vaults are not implemented.

## Resolution precedence

`resolveEffectiveVault` picks the target in this order, first match wins:

| Rank | Source | Where it comes from | Write surface |
| --- | --- | --- | --- |
| 1 | `explicit` | `--vault <path>` on the command line | Verified |
| 2 | `vault` | Local vault ontology: `.oms/concepts/` or `.oms/taxonomy.yaml` in the current directory | Verified |
| 3 | `bridge` | Local bridge record: `.oms/links.yaml` | Verified |
| 4 | `env` | `OMS_VAULT` environment variable | Verified |
| 5 | `global` | `~/.oms/config.yaml` | Verified, if the registered path still holds a `.oms` ontology |
| 6 | `cwd` | Fallback to the starting directory | **Unverified**, writes rejected |

The first two `.oms` profiles never collide because resolution is content-based: a directory holding concepts or a taxonomy is a vault, a directory holding `links.yaml` is a bridge.

`cwd` is a read-only fallback. Every read tool works fine on it. The `write` tool rejects with `target-unverified` rather than creating a note in whatever directory the server booted from. `oms mcp` still starts normally on a `cwd` target, since refusing to boot would break the read tools; only the write surface is gated. You can see the posture in the `oms_graph_status` response, whose `writeTools` field reads `write-disabled-target-unverified` on a `cwd` target and `write-gated-by-verified-target-and-contract` otherwise.

## Rejection codes

Every refusal returns a structured payload:

```json
{
  "stage": "admission",
  "code": "target-unverified",
  "message": "Refusing to write: the target vault was inferred from the current directory ...",
  "recoverable": true,
  "remediation": "run `oms setup` in your Obsidian vault (or set OMS_VAULT / register the vault in ~/.oms/config.yaml), then retry"
}
```

`recoverable: true` means retrying with corrected inputs can succeed without touching anything outside the call. `recoverable: false` means the environment or the vault itself needs attention first.

| Code | Stage | Recoverable | What happened | Remediation |
| --- | --- | --- | --- | --- |
| `target-unverified` | admission | `true` | The vault was inferred from the current directory, which is not a verified target | Run `oms setup` in your vault, set `OMS_VAULT`, or register the vault in `~/.oms/config.yaml`, then retry |
| `target-invalid` | admission | `false` | The globally registered vault has no `.oms` ontology (stale pointer) | Point `~/.oms/config.yaml` at your real vault, or run `oms setup` in that vault |
| `path-unsafe` | admission | `true` | The note path escapes the vault, isn't `.md`, or targets a hidden or internal folder | Pass a vault-relative `notePath` ending in `.md` that stays inside the vault |
| `note-exists` | admission | `false` | `create` was asked to overwrite an existing note | Use mode `append` or `update`, or choose a different filename |
| `note-missing` | admission | `false` | `append` or `update` targeted a note that isn't there | Create the note first with mode `create`, or correct `notePath` |
| `concept-unbound` | admission | `false` | The note path doesn't resolve to a concept binding | Move the note into a folder bound to a concept in `taxonomy.yaml`, or target an existing bound note |
| `contract-violation` | admission (missing fields) / acceptance (staged render) | `true` | The frontmatter doesn't satisfy the concept contract, or the values don't survive the render unchanged | Provide or correct the fields named in the message, then retry |
| `body-missing` | admission (no `body` argument) / acceptance (staged render is empty) | `true` | `create` was called without a body, or the rendered note carries no body content | Pass a non-empty `body`, then retry |
| `args-invalid` | admission | `true` | Required arguments for the mode are missing (`notePath` for `append`/`update`, frontmatter or body for `update`) | Pass the missing argument, then retry |
| `postcondition-failed` | acceptance | `false` | The persisted file failed re-validation: frontmatter broke the contract, or the body doesn't match what was staged | Inspect the persisted file (it was **not** removed) and repair or delete it before retrying |

Contract-fixable results come back with `status: "ask"` and carry a `contract-violation` rejection alongside `missingFields`, so an agent can ask you for the missing values and retry. Everything else that refuses comes back with `status: "rejected"`.

## Receipts

A successful write carries a receipt. It's how you confirm where the note actually landed without trusting the agent's narration.

| Field | Meaning |
| --- | --- |
| `resolvedVault` | Absolute path of the vault the note was written into |
| `resolutionSource` | Which rule picked that vault: `explicit`, `vault`, `bridge`, `env`, or `global` |
| `notePath` | Vault-relative path of the note |
| `mode` | `create`, `append`, or `update` |
| `concept` | The bound concept name, or `null` |
| `postconditionVerified` | Always `true` on a receipt: the file was re-read and re-validated after persisting |

Receipts are issued only for persisted, postcondition-verified writes. A `dryRun` gets no receipt because nothing was persisted. An `inbox` routing plan gets neither a receipt nor a rejection, since it's a suggestion rather than a write.

Independently of the receipt, every MCP `write` response also carries top-level `resolvedVault` and `resolutionSource` keys, so even a rejection tells you which vault the server was aiming at.

## Migration

If you installed Oh My Second Brain before verified-target writes shipped, you have no `~/.oms/config.yaml`. Reads keep working, and writes from inside your vault keep working. Writes from an MCP server started outside a vault will be rejected with `target-unverified` until you register the vault once:

```bash
cd /path/to/your/vault
oms setup
```

Or let the installer backfill from your existing environment variable:

```bash
OMS_VAULT=/path/to/your/vault oms install
```

The backfill only fires when no global config exists yet, so re-running install won't clobber a vault you registered deliberately. Verify either way:

```bash
cat ~/.oms/config.yaml
```

## Adapter parity

The fix is entirely server-side. **No adapter files change.**

- Root `.mcp.json` keeps `args: ["mcp"]`. The server now resolves the vault from the global registry instead of the launch directory, which is exactly the behavior this registration always wanted.
- Root `.mcp.codex.json` keeps its `--vault .` registration, which resolves as `explicit` and was never affected.
- Hermes registers the same `oms mcp` command through `~/.hermes/config.yaml`; nothing to change.

Related but not fixed here: issue #56, where the Claude plugin registers a bare user-scoped MCP server rather than a plugin-owned one and ships no usable write skill. That's a packaging and skill-surface problem in the adapter layer. Verified-target writes make the bare registration behave correctly at runtime, but they don't turn it into a plugin-owned server or add the missing write skill.
