# Verified-Target Writes

Reading a vault is safe from anywhere. Writing is not. If an MCP server boots in `~/Documents` and an agent asks it to capture a note, "wherever the process happens to be" is the wrong answer. Oh My Second Brain's write surface therefore refuses to guess: a note is persisted only into a vault that was resolved from a trusted source, and only after the note that landed on disk has been read back and re-checked.

This page describes the write kernel and every rejection it can return. Read tools and the read-only `status` surface still run anywhere. `doctor` diagnoses and repairs, so its repair operations follow the same verified-target rule as `write`.

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

- **Target** the vault came from a trusted resolution source.
- **Path** the note path is vault-relative, ends in `.md`, stays inside the vault, and avoids hidden or internal folders.
- **Mode** `append` and `update` carry a `notePath`; `update` carries frontmatter, a body, or both; `create` carries a body.
- **Overwrite** `create` refuses an existing note; `append` and `update` refuse a missing one.
- **Binding** for `append` and `update`, the note path resolves to a folder bound to a concept in `taxonomy.yaml`. A `create` that matches no binding isn't rejected at all: it comes back as an `inbox` routing plan instead.

Acceptance verifies:

- The frontmatter satisfies the concept's required fields, types, and declared intent.
- The staged render survives round-tripping without dropping or mangling contract fields.
- The staged body isn't empty.
- The persisted file, re-read from disk, still satisfies the contract and contains the intended body.

## Resolution precedence

`resolveEffectiveVault` picks the target in this order, first match wins:

| Rank | Source | Where it comes from | Write surface |
| --- | --- | --- | --- |
| 1 | `explicit` | `--vault <path>` on the command line | Verified |
| 2 | `vault` | Local vault ontology: `.oms/concepts/` or `.oms/taxonomy.yaml` in the current directory | Verified |
| 3 | `bridge` | Local bridge record: `.oms/links.yaml` | Verified |
| 4 | `env` | `OMS_VAULT` environment variable | Verified |
| 5 | `cwd` | Fallback to the starting directory | **Unverified**, writes rejected |

The first two `.oms` profiles never collide because resolution is content-based: a directory holding concepts or a taxonomy is a vault, a directory holding `links.yaml` is a bridge.

`cwd` is a read-only fallback. Every read tool and `oms_doctor` diagnosis works fine on it. `oms_write` and `oms_doctor` repair operations reject with `target-unverified` rather than modifying whichever directory the server booted from. `oms mcp` still starts normally on a `cwd` target because `oms_status`, `oms_search`, and diagnosis remain available.

## Rejection codes

Every refusal returns a structured payload:

```json
{
  "stage": "admission",
  "code": "target-unverified",
  "message": "Refusing to write: the target vault was inferred from the current directory ...",
  "recoverable": true,
  "remediation": "run `oms setup` in your Obsidian vault (or set OMS_VAULT), then retry"
}
```

`recoverable: true` means retrying with corrected inputs can succeed without touching anything outside the call. `recoverable: false` means the environment or the vault itself needs attention first.

| Code | Stage | Recoverable | What happened | Remediation |
| --- | --- | --- | --- | --- |
| `target-unverified` | admission | `true` | The vault was inferred from the current directory, which is not a verified target | Run `oms setup` in your vault, pass `--vault`, set `OMS_VAULT`, or bridge with `oms link` |
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
| `resolutionSource` | Which rule picked that vault: `explicit`, `vault`, `bridge`, or `env` |
| `notePath` | Vault-relative path of the note |
| `mode` | `create`, `append`, or `update` |
| `concept` | The bound concept name, or `null` |
| `postconditionVerified` | Always `true` on a receipt: the file was re-read and re-validated after persisting |

Receipts are issued only for persisted, postcondition-verified writes. A `dryRun` gets no receipt because nothing was persisted. An `inbox` routing plan gets neither a receipt nor a rejection, since it's a suggestion rather than a write.

Independently of the receipt, every MCP `write` response also carries top-level `resolvedVault` and `resolutionSource` keys, so even a rejection tells you which vault the server was aiming at.

## Breaking change: the global vault registry is gone

Earlier versions of Oh My Second Brain also resolved a target from a global registry at `~/.oms/config.yaml`, written automatically by `oms setup` or `oms install --vault`. That tier has been removed entirely — there is no longer a sixth fallback behind `env`.

If you run `oms` (CLI or `oms mcp`) from a directory that is **not** a vault, with no bridge and no `OMS_VAULT`, and you previously relied on `~/.oms/config.yaml` to resolve your vault: that no longer happens. The invocation now resolves to `cwd`, and every write is rejected with `target-unverified`.

The remedies:

- Run the command from inside the vault (a directory holding `.oms/concepts/` or `.oms/taxonomy.yaml`).
- Pass `--vault <path>` explicitly.
- Set the `OMS_VAULT` environment variable.
- Bridge the calling directory to the vault with `oms link`, which writes `.oms/links.yaml`.

**MCP hosts are the most likely place this bites.** Any host configuration that launches `oms mcp` with no `--vault` argument and no `OMS_VAULT` in its env block was relying on the registry to resolve a vault. Those configurations will stop resolving a vault and must be updated to pass `--vault` or set `OMS_VAULT` in the server's env block.

**Claude is no longer an exception.** Codex's `.mcp.codex.json` has always shipped with `--vault .`, and Hermes has always resolved the vault through `~/.hermes/config.yaml` — neither adapter ever depended on the registry. Claude was the one that did: the plugin's `.mcp.json` ships with a bare `args: ["mcp"]` and no vault, because npm owns and rewrites that file on every `oms update`, so it can never carry a user's vault. Before this change, that gap was papered over by the registry; removing the registry would have made every Claude installation stop resolving a vault outright.

It doesn't anymore. `oms install`/`oms uninstall` now register (and remove) a user-scope MCP server entry for `oms` in `~/.claude.json`, with the resolved vault baked in as an absolute path via `--vault`. A user-scope entry shadows the plugin-provided one at the same name (Claude's scope precedence is Local > Project > User > Plugin-provided, and fields are not merged across scopes), so this is what actually resolves the vault day to day; the plugin's bare `.mcp.json` stays untouched as the fallback for anyone who sets `OMS_VAULT` themselves.

**This does not close issue #56, and on one point deliberately moves away from it.** That issue asks for the opposite arrangement: a plugin-owned MCP surface displayed as `plugin:<plugin-id>:<server-id>`, with *no* separate bare user `oms` registration. This change entrenches a user-scope registration instead. The reason is structural rather than a matter of taste — a plugin-owned manifest is npm-owned and rewritten on every `oms update`, so it cannot carry a per-machine absolute vault path; a user-scope entry is the only place the vault can currently live. What this change does fix is the symptom that issue opened on: the registration is no longer vault-less. Issue #56's own acceptance criterion — plugin-owned naming with the user registration removed — stands unmet, and stays open.

Its second half is only partly addressed too. `assets/skills/write/SKILL.md` is no longer the 16-line stub #56 quoted: it now documents the `op` values and the four kernel statuses (`ask`, `inbox`, `written`, `rejected`). It still does not teach the full parameter set or the receipt shape, which is what that criterion actually asks for, so it also stays open. The relevant point for *this* change is narrower: the skill ships identically to every adapter, so nothing here makes Claude's write path worse than Codex's or Hermes's.
