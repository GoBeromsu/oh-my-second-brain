# Release Oh My Second Brain

Oh My Second Brain releases are npm-first and Claude Code validated. The release process must prove the published tarball works, not merely the repository checkout.

Releasing is one operator command. Everything after the tag push belongs to CI.

## Principles

Seven rules shape this pipeline. They're adopted from [gajae-code](https://github.com/Yeachan-Heo/gajae-code), which the project owner picked as the reference release discipline.

1. **CHANGELOG-first release messages.** Contributors write user-facing notes in the matching layer changelog: `CHANGELOG-kernel.md`, `CHANGELOG-cli.md`, `CHANGELOG-mcp.md`, `CHANGELOG-vendors.md`, or `CHANGELOG-assets.md`. `CHANGELOG.md` is the aggregate index, with entries only for changes spanning layers. Release notes are never reconstructed from git log at release time. `scripts/changelog-history-guard.mjs` runs in `ci.yml` and fails the build if a released `## [X.Y.Z]` heading that exists on `origin/main` disappears from the working tree.
2. **One-command operator release.** `npm run release -- <X.Y.Z>` does preflight, lockstep version bump, changelog roll, `release:check`, commit, tag, atomic push, and CI watch. There's no checklist to follow by hand.
3. **Tag immutability and fix-forward.** An `oms-v*` tag is never retagged, deleted, or force-pushed. A bad release is corrected by committing the fix on `main` and releasing a newer version.
4. **Tag equals version.** The tag `oms-vX.Y.Z` must match `package.json`, the two root plugin manifests, and `assets/hermes-manifest.json`. Release CI checks this before anything else and refuses to publish when the carriers drift.
5. **CI-only publish.** `npm publish` runs inside `.github/workflows/release.yml` and nowhere else. There is no local publish path, and the operator script never invokes npm publish.
6. **Tested release logic.** All non-trivial release logic lives in `scripts/release-lib.mjs` as pure functions (changelog roll, notes extraction, version bump, lockstep comparison, semver checks) covered by vitest. The scripts around it stay thin.
7. **Attested measurement evidence for ranking-default changes.** The shipped
   default is the released v0.3.0 `boost-additive` baseline: RRF score plus
   provenance boost (`score: hit.score + boost`), with no per-list reordering. `boost-k-scale`,
   `boost-per-list`, and `boost-zero` are frozen experiment arms, not the
   current default. A release that ships the baseline passes the
   `boost-c040` gate with a receipt and needs no manifest. A release that
   changes the default away from that baseline must validate the exact
   human-supplied manifest at `docs/measurements/boost-c040.json`, including
   the externally preregistered qrels digest, trusted Ed25519 key, valid
   attestation, and paired raw evidence. In particular, adopting an experiment
   arm requires that manifest. No fixture, synthetic manifest, or waiver can
   satisfy that requirement.

## Release contract

The npm package root is the runtime asset root. A releasable tarball must include:

- `dist/cli/oms.js`
- `dist/mcp/server.js`
- `.claude-plugin/plugin.json`
- `assets/skills/*/SKILL.md`
- `assets/codex/rules/oms.md` and `assets/hermes-manifest.json`
- `docs/install.md`, `docs/architecture.md`, `docs/conventions.md`, and `docs/verified-target.md`
- `scripts/install.sh`
- `scripts/uninstall.sh`
- `CHANGELOG.md` and the five layer changelogs
- `ACKNOWLEDGMENTS.md`, because the licence section links to it

This document is deliberately NOT in that list. It tells the reader how to
release this package, which an installed consumer cannot do; shipping it would
put instructions in the artifact that only apply to the repository. The READMEs
link to the repository copy instead.

`src/` is TypeScript source only. Host assets and the shared skill source stay at
the package root. Template authority is vault-resident; the package ships no
bundled note-type defaults.

Codex and Hermes host assets are packaged as host-native skill/rule bundles plus MCP registrations; release notes must describe the exact installed paths and avoid claiming behavior beyond the shipped skills and MCP tools.

## Operator flow

```bash
npm run release -- 0.14.0
```

That's the whole release. `scripts/release.mjs` runs these stages in order and aborts at the first failure.

### 1. Preflight (nothing is mutated yet)

Every check below runs before a single file or git ref changes, so a failed preflight leaves the tree exactly as it was:

- `git status --porcelain` must be empty. A dirty tree aborts with the offending lines listed.
- The current branch must be `main`. Any other branch aborts naming where you actually are.
- `git fetch origin main` must succeed, and `HEAD` must equal `origin/main`. Being ahead or behind aborts with both SHAs.
- `gh auth status` must exit 0. Otherwise: run `gh auth login` first.
- The version argument must be a stable `X.Y.Z` (no prereleases, no `v` prefix).
- The new version must be strictly greater than the current `package.json` version.
- The tag `oms-v<version>` must not exist locally (`git tag -l`) or on origin (`git ls-remote --tags origin`). If it does, the abort message says tags are immutable and asks for a newer version.

### 2. Lockstep version bump

Five files get the new version: `package.json`, `package-lock.json` (root `version` plus `packages[""].version`), `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and `assets/hermes-manifest.json`. The script then re-reads all of them and asserts consistency. If anything is off, it stops and tells you to run `git checkout -- .`, since nothing has been committed yet.

### 3. Changelog roll

The release process rolls all six changelogs — the aggregate `CHANGELOG.md` and the five layer files — in one transaction. Each file's `## [Unreleased]` section becomes `## [<version>] - <UTC date>` and a fresh empty `## [Unreleased]` is reinstated above it. Every roll is precomputed before anything is written, so a malformed file fails the release before any other changelog is touched rather than leaving some layers released and others not.

A layer with nothing under `[Unreleased]` is normal — most releases touch a subset of layers — and is not an error.

Released sections pass through byte-identical. The immutability guard identifies a section by `{file, version}`, not by version alone: after a release every layer carries the same version heading, so keying on the version would let an edit to one layer hide behind another layer that still holds it.

An empty `## [Unreleased]` body is a hard error: *empty [Unreleased] - write release notes before releasing*. Write the notes, or pass the escape hatch when a release genuinely carries nothing user-facing:

```bash
npm run release -- 0.14.0 --allow-empty-changelog
```

With that flag the version heading is inserted below an intact empty `## [Unreleased]`, giving the GitHub Release an empty section. Use it sparingly; the flag exists for mechanical releases, not for skipping the write-up.

### 4. Release gate

`npm run release:check` runs with inherited stdio, so you see every child's output:

1. `npm run lint`
2. `npm run build`
3. `npm test`
4. `npm run audit`
5. `npm run check:docs`
6. `npm run check:measurement`
7. `npm run release:pack`
8. `npm run release:artifact-smoke`
9. `npm run release:plugin`

`release:pack` inspects `npm pack --dry-run --json` and fails if required runtime assets are missing. `release:artifact-smoke` creates a real tarball, unpacks it into a temp directory, installs production dependencies there, and exercises approved setup/template mutations, `host install|sync|remove`, `package check|update`, `serve http|mcp`, canonical note/search/index commands, and the five-tool MCP surface from the extracted package root. All child processes use an isolated home, and the smoke verifies that the operator's real `~/.oms` metadata did not change.

When the release ships the `boost-additive` baseline, `check:measurement`
passes the `boost-c040` gate with a receipt and does not require
`docs/measurements/boost-c040.json`. When the release changes the shipped
ranking default, `check:measurement` selects `boost-c040` and validates that
exact manifest. Before that check, configure `OMS_PREREG_QRELS_HASH` (or
`OMS_PREREG_QRELS`) with the frozen external qrels evidence and
`OMS_MEASUREMENT_TRUSTED_PUBLIC_KEY` with the trusted Ed25519 release key.
`OMS_MEASUREMENT_ATTESTATION_REQUIRED=1` requires a signed attestation over
the immutable manifest payload, and required release checks also require
paired raw evidence for each of the three preregistered arms. All three arms
are measured; the calculated C040 result compares the selected candidate
(`boost-k-scale` or `boost-per-list`) against the `boost-zero` control under
the preregistered thresholds. A claimed verdict or hard-coded winner is never
accepted, and the shipped ranking default must equal the arm the evidence
selects as the winner: authentic evidence for one arm never authorises
shipping another. There is no `boost-c040` waiver. See [measurement
evidence](./measurements/README.md) for the profile-specific invocation and
evidence contract.

If the gate fails, the bump and changelog roll are still sitting uncommitted in your working tree. Fix the failure and re-run, or `git checkout -- .` to restore.

### 5. Commit, tag, atomic push

`git add -u`, commit `chore(release): bump version to <version>`, `git tag oms-v<version>`, then `git push --atomic origin main oms-v<version>`. The push is atomic, so a rejected push moves neither ref and nothing is published. Fix the cause and re-run the push.

### 6. CI watch

The script polls `gh run list --workflow=release.yml` every 15 seconds for up to 30 minutes, matching runs by `headSha`, and reports the conclusion. On failure or timeout it prints fix-forward guidance: the tag is immutable, never retag or force-push, commit the fix on `main` and release a newer version, inspect the run with `gh run view <databaseId> --log-failed`.

If you lose the terminal, reattach to the run for the current `HEAD`:

```bash
npm run release -- watch
```

## CI flow

Pushing an `oms-v*` tag triggers `.github/workflows/release.yml`; release verification does not run per pull request. Steps, in order:

1. **Guard tag matches every version carrier** (tag runs only). Reads `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and `assets/hermes-manifest.json` and compares them against `$GITHUB_REF_NAME`. Any drift fails the job and prints each value, so you see exactly which carrier is out of lockstep.
2. `npm ci`.
3. **Install Claude CLI for plugin validation**. Installs `@anthropic-ai/claude-code` globally and runs `claude --version`. Success means the later gate performs real plugin validation. Failure is an environment failure and stops the job with remediation text, unless an attestation input was supplied on a dispatch run.
4. `npm run release:check`. Same gate you ran locally, this time with `OMS_REQUIRE_PLUGIN_VALIDATION=1` set, so `release:plugin` cannot silently skip validation. When the shipped ranking default changes from `boost-additive`, the job's `boost-c040` measurement environment points at `docs/measurements/boost-c040.json`, supplies the external qrels hash and trusted key, and requires attestation and paired raw evidence. A baseline release uses the gate receipt and needs no manifest.
5. **Publish to npm with provenance** (tag runs only). Calls `node scripts/npm-version-exists.mjs <version>` first: exit 1 (absent) leads to `npm publish --provenance --access public`; exit 0 (already published) logs an idempotent-re-run skip; any other exit means the registry check itself failed, and the job refuses to publish on an inconclusive result.
6. **Create GitHub Release** (tag runs only). `node scripts/extract-release-notes.mjs <version>` reads `CHANGELOG.md` and writes that version's section body to `/tmp/notes.md`, then `gh release view "$GITHUB_REF_NAME" || gh release create ... --notes-file /tmp/notes.md --verify-tag`. An existing release is left untouched. An empty or missing changelog section fails the step rather than shipping blank notes.

The job carries `contents: write` for the GitHub Release and `id-token: write` for npm provenance.

### Idempotent re-runs

Re-running a failed tag run is safe. The registry check keeps the publish step from double-publishing, and `gh release view` keeps the release step from recreating an existing release. Re-running the same tag after a partial failure completes the missing half.

## Rehearsal

The whole pipeline, including headless Claude CLI validation, is provable without publishing anything:

```bash
gh workflow run release.yml --ref <branch> -f rehearsal=true
```

A `workflow_dispatch` run has no tag ref, so the guard, publish, and GitHub Release steps are skipped by their `if:` conditions. What still runs: `npm ci`, the Claude CLI install and version check, the full `release:check` (real `claude plugin validate`), and the **Dry-run publish (rehearsal)** step, `npm publish --dry-run --access public`. No token, no registry write, no release page. The dry-run step always runs against the current (normally already-published) version; `npm publish --dry-run` performs the server-side precondition check and rejects publishing over previously published versions. The rehearsal treats this specific rejection for the current version as the expected outcome, confirming the package is valid; any other error (packing, manifest, or already-published for a different version) still fails the step.

Run a rehearsal on any branch that changes the release pipeline itself.

### Cross-version updater rehearsal

Do not use retired command aliases to simulate an upgrade. The v0.13 updater
finishes its own workflow by invoking the retired `reconcile` command, but only
**after** it has installed the new package. That call is old-client behavior,
not a public compatibility promise in v0.14.

Rehearse the supported boundary in an isolated external prefix: install the
published old package version there, let its updater install the candidate new
package, then invoke the new package's canonical host reconciliation command:

```bash
prefix="$(mktemp -d)"
npm install --prefix "$prefix" oh-my-second-brain@0.13.0
npm install --prefix "$prefix" ./oh-my-second-brain-0.14.0.tgz
"$prefix/node_modules/.bin/oms" host sync --runtime all --vault /path/to/rehearsal-vault --dry-run
```

The rehearsal must use a disposable `HOME`/`USERPROFILE` and vault. A successful
test proves package-to-package upgrade and the new `host sync` surface; it does
not justify keeping retired reconciliation or top-level update aliases.

## Claude plugin validation

Validation is CI-first. The workflow installs the Claude CLI and `scripts/release-plugin.mjs` runs the real check:

```bash
claude plugin validate .
```

That's also the command to run locally when debugging an adapter failure. A `claude plugin validate` failure inside `release:check` is a plugin content error: fix the root plugin assets, don't work around the pipeline. Never disable `OMS_REQUIRE_PLUGIN_VALIDATION`.

Only when the CLI itself can't run (install or `claude --version` fails, an environment failure) does the attestation fallback apply. `release-plugin.mjs` reads `OMS_PLUGIN_VALIDATION_ATTESTATION` as inline JSON or as a path to a JSON file, requires `actor`, `timestamp`, `command`, `pluginPath`, and `exitCode`, and rejects anything with a non-zero `exitCode`.

```json
{
  "actor": "person-or-bot",
  "timestamp": "2026-06-02T00:00:00Z",
  "command": "claude plugin validate .",
  "pluginPath": ".",
  "claudeVersion": "optional version string",
  "exitCode": 0,
  "warnings": ["optional warning text"],
  "artifact": "optional log path or URL"
}
```

## Emergency dispatch

`workflow_dispatch` is the emergency and rehearsal path, never the normal one. It's how you carry an attestation into a run whose environment can't host the Claude CLI:

```bash
gh workflow run release.yml --ref main \
  -f rehearsal=true \
  -f plugin_validation_attestation="$(cat plugin-validation.json)"
```

A dispatch run never publishes for real: the publish and GitHub Release steps are gated on `github.ref_type == 'tag'`. An emergency real release still goes out the normal way, by pushing a tag through `npm run release -- <X.Y.Z>`.

## Version and package-name preflight

Before releasing:

1. Verify that the `oh-my-second-brain` npm package is publishable by the current publisher.
2. Confirm release notes list Codex rules/skills and Hermes skill-bundle install paths, plus the MCP registration files that make capture/retrieve tools available.
3. Run the single operator command shown above. Do not hand-edit a version carrier.

The operator script bumps and verifies every version carrier in lockstep.

## Rollback posture

Do not rely on npm unpublish as a normal rollback path. Prefer publishing a fixed patch release and documenting any broken version in release notes.

Concretely: leave the bad tag and the bad npm version alone, commit the fix on `main`, add a note under `## [Unreleased]` saying what broke, and run `npm run release -- <next X.Y.Z>`. Fix-forward is the only rollback this project supports.
