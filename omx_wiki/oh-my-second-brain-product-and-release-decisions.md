---
title: "Oh My Second Brain product and release decisions"
tags: ["oh-my-second-brain", "oms", "architecture", "release", "npm", "mcp", "obsidian"]
created: 2026-06-03T06:05:20.951Z
updated: 2026-06-03T06:05:20.951Z
sources: []
links: []
category: decision
confidence: medium
schemaVersion: 1
---

# Oh My Second Brain product and release decisions

## Summary

Oh My Second Brain is the human-facing project name. `oh-my-second-brain` is the canonical repo/package/install name. `oms` remains a backward-compatible compact runtime alias for existing CLI/MCP/skill IDs. The npm package name is `oh-my-second-brain` because the unscoped npm name `oms` is owned by another account/unpublished package and cannot be published by us.

## Product intent

The project is a host-agnostic convention harness for Obsidian/plain-markdown vaults. A vault is treated as a folder of markdown files, not primarily as an Obsidian app integration. The harness gives agents a deterministic frame for operating the user's knowledge system; it does not generate or judge the note body.

Core thesis: note-making is valuable because it improves future retrieval and reuse. Capture quality is therefore judged by whether the note can be found later through the user's declared axes.

## Knowledge axes

The stable retrieval/capture axes are:

- Folder axis: folders are semantic; a folder declares an intent and can bind to one or more concepts.
- Frontmatter property axis: each declared property is a dimension of the user's knowledge system.
- Frontmatter value axis: property values become graph nodes/edges for navigation and retrieval.
- Wikilink axis: explicit body links are another intentional dimension.
- Body payload: body content is user-owned payload, lazy-loaded after axis/search narrowing.

This preserves the user's own ontology. Oh My Second Brain ships defaults, but setup copies them into `vault/.oms/`; after that the user owns the live convention. Unknown frontmatter is preserved. Violations are warnings by default.

## Capture vs retrieval

Data capture and data retrieval are separate flows even though they use the same axes.

Capture flow:

1. Infer or ask for folder/concept/frontmatter fields from the declared ontology.
2. Route ambiguous input to inbox or ask for missing required fields.
3. Commit only after path confinement and contract validation.
4. Do not overwrite user ontology or judge body quality.

Retrieval flow:

1. Narrow by folder/concept/property/value/wikilink axes first.
2. Use lexical/vector/hybrid search only as a derived support layer after, or alongside, axis narrowing.
3. Lazy-load note bodies only after candidate notes are selected.

## External inspirations and boundaries

- Ouroboros: installable harness posture, skills, MCP/runtime state surfaces, deterministic gates. Oh My Second Brain borrows patterns, not the product identity or OS-above-host orchestration role.
- QMD: anywhere access to markdown knowledge through CLI/MCP/skills; useful model for retrieval availability. Oh My Second Brain differs by making frontmatter/folder/wikilink axes first-class user-owned ontology graph dimensions.
- Graphify: graph affordance for retrieval; Oh My Second Brain's graph is grounded in intentional user-authored metadata and links rather than inferred body concepts by default.

Not goals: fixed taxonomy, content generator, body-quality judge, Obsidian-plugin-first architecture, generic search-only tool.

## Host surfaces

The current installable surfaces are Claude Code, Codex, and Hermes. All share the same TypeScript runtime and MCP tools, while adapters absorb host-specific structure.

Current technical contract:

- npm package: `oh-my-second-brain`
- CLI command: `oh-my-second-brain` (canonical), `oms` (compatibility alias)
- MCP server/config key: `oms` (compatibility runtime ID)
- vault ontology directory: `.oms/`
- Codex skills namespace: `oms-*`
- GitHub repo slug: `GoBeromsu/oh-my-second-brain`

## Release decisions

`oms` could not be published to npm because `npm owner ls oms` showed an existing owner and the package name is unavailable. We publish under `oh-my-second-brain` and expose `oh-my-second-brain` as the canonical CLI command while preserving `oms` as a compatibility alias.

Published versions:

- `oh-my-second-brain@0.1.5`: first npm publish after using a recovery code.
- `oh-my-second-brain@0.1.6`: fixed docs/runtime command surfaces to prefer the published npm package and installed `oh-my-second-brain` binary instead of stale GitHub-release `npx` tarball URLs.
- `oh-my-second-brain@0.1.8`: current/latest; aligns package docs and installer defaults with the package metadata.

Install command:

```bash
npm install -g oh-my-second-brain@0.1.8
oh-my-second-brain --help
oh-my-second-brain install --runtime all --vault /path/to/vault --dry-run
```

GitHub release `oh-my-second-brain-v0.1.8` includes `oh-my-second-brain-0.1.8.tgz`.

## Verification evidence

Before release/publish we verified:

- `npm run release:check`
- npm registry publish and `npm view oh-my-second-brain@0.1.8`
- temporary `npm install oh-my-second-brain@0.1.8`
- `./node_modules/.bin/oh-my-second-brain --help`
- `./node_modules/.bin/oh-my-second-brain install --runtime all --vault /tmp/Vault --dry-run`
- GitHub release asset download and CLI execution from the tarball

## Security note

Do not store npm recovery codes in `.env`; they are single-use emergency codes. The local `.env` may hold `NPM_TOKEN`, but long-term unattended publishing requires a new granular npm token with read/write publish permission and 2FA bypass explicitly enabled. The token and `.npmrc` must remain ignored and must never be committed.

## Forward directive

Future changes should keep **Oh My Second Brain** as the display/product name and `oh-my-second-brain` as the GitHub repository, npm package, and canonical installed command. Keep `oms` only as a backward-compatible runtime alias unless a migration removes it deliberately.
