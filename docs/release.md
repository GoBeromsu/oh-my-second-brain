# Release Oh My Second Brain

Oh My Second Brain releases are npm-first and Claude Code validated. The release process must prove the published tarball works, not merely the repository checkout.

## Release contract

The npm package root is the runtime asset root. A releasable tarball must include:

- `dist/cli/oms.js`
- `dist/mcp/server.js`
- `core/ontology/taxonomy.yaml`
- `core/ontology/concepts/`
- `adapters/claude-code/.claude-plugin/plugin.json`
- every Claude adapter `skills/*/SKILL.md`
- Codex and Hermes adapter skill bundles, including the update skill surface
- `docs/install.md`
- `docs/release.md`
- `scripts/install.sh`
- `scripts/uninstall.sh`

`src/` is TypeScript source only. Bundled host/ontology assets intentionally stay
at the package root so the built CLI can read the same package-root layout in
source checkouts and in published tarballs.

Codex and Hermes adapter files are packaged as host-native skill/rule bundles plus MCP registrations; release notes must describe the exact installed paths and avoid claiming behavior beyond the shipped skills and MCP tools.

## Local release gate

Run this before tagging or publishing:

```bash
npm run release:check
```

`release:check` runs:

1. `npm run lint`
2. `npm run build`
3. `npm test`
4. `npm run audit`
5. `npm run release:pack`
6. `npm run release:artifact-smoke`
7. `npm run release:plugin`

`release:pack` inspects `npm pack --dry-run --json` and fails if required runtime assets are missing. `release:artifact-smoke` creates a real tarball, unpacks it into a temp directory, installs production dependencies there, and runs setup, host install dry-run, update dry-run, and MCP smoke from the extracted package root.

## Claude plugin validation

Preferred validation:

```bash
claude plugin validate adapters/claude-code
```

If a release environment cannot run the Claude CLI, publishing is blocked unless an explicit validation attestation is provided through `OMS_PLUGIN_VALIDATION_ATTESTATION`.

Required attestation fields:

```json
{
  "actor": "person-or-bot",
  "timestamp": "2026-06-02T00:00:00Z",
  "command": "claude plugin validate adapters/claude-code",
  "pluginPath": "adapters/claude-code",
  "claudeVersion": "optional version string",
  "exitCode": 0,
  "warnings": ["optional warning text"],
  "artifact": "optional log path or URL"
}
```

## GitHub release workflow

The v0 release workflow is **manual dispatch only** so the operator must provide the Claude plugin validation attestation explicitly when the GitHub runner cannot run Claude Code itself. It is credential-gated and uses npm provenance:

- It runs only through `workflow_dispatch`.
- It requires `plugin_validation_attestation` input.
- It runs the full release gate before publish.
- It requires `NPM_TOKEN`.
- It requires `id-token: write` for provenance.
- It refuses to publish `0.0.0`; bump to a real semver first.
- It runs `npm publish --provenance --access public` only in the publish job.
- It blocks publish if Claude plugin validation was skipped without attestation.

## Version and package-name preflight

Before the first public release:

1. Verify that the `oh-my-second-brain` npm package is publishable by the current publisher.
2. Bump `package.json` to a real semver release.
3. Keep `adapters/claude-code/.claude-plugin/plugin.json` version in sync with `package.json` unless a future ADR deliberately splits package/plugin versioning.
4. Confirm release notes list Codex rules/skills and Hermes skill-bundle install paths, plus the MCP registration files that make capture/retrieve tools available.

## Rollback posture

Do not rely on npm unpublish as a normal rollback path. Prefer publishing a fixed patch release and documenting any broken version in release notes.
