# Host Asset Contract

Oh My Second Brain keeps shared skills in `assets/skills/` and host-specific runtime assets in explicit directories under `assets/`. There is no adapter bundle directory.

| Host | Manifest/config | Host assets | Installation destination |
|---|---|---|---|
| Claude Code | Root `.claude-plugin/plugin.json` and `.mcp.json` | `assets/claude/CLAUDE.md`, `assets/claude/hooks/` | Plugin root; guard hooks are installed through `~/.claude/settings.json`. |
| Codex | Root `.codex-plugin/plugin.json` and `.mcp.codex.json` | `assets/codex/AGENTS.md`, `assets/codex/rules/oms.md` | `~/.codex/plugins/oms/AGENTS.md`, `~/.codex/rules/oms.md`, and `~/.codex/skills/oms-*`. |
| Hermes | `assets/hermes-manifest.json` | `assets/hermes/SOUL.md`, `assets/hermes/README.md` | `~/.hermes/adapters/oms/`, `~/.hermes/skills/knowledge-management/oms/`, and `~/.hermes/config.yaml`. |
| Gajae-Code | Marketplace-plugin convention | Generated root `skills/` mirror | The installed npm package root, where GJC discovers `skills/<name>/SKILL.md`. |

Claude's manifest retains its explicit skill array; Codex's manifest retains its single shared skill-directory declaration. Both resolve `./assets/skills/` inside the repository-root plugin.

`assets/skills/` remains the sole authored skill source. The root `skills/` tree is a committed generated mirror for GJC only: it cannot be a symlink because npm drops that symlink from packed artifacts. `npm run sync:skills` regenerates it, and the architecture gate requires matching directories and byte-identical `SKILL.md` files.

The MCP server is started with `oms mcp`. Claude uses `.mcp.json`, Codex uses `.mcp.codex.json`, and Hermes receives its registration in `~/.hermes/config.yaml`.

All hosts expose the same five MCP tools. Registering an existing template remains
an operation of `write`, not a sixth tool:

```json
{
  "op": "template",
  "mode": "register-existing",
  "templateId": "note",
  "sourceFolder": "Team/Curated Shapes",
  "sourcePath": "Team/Curated Shapes/note.md",
  "contract": "note",
  "naming": "{{date}}-{{slug}}.md",
  "dryRun": true
}
```

`sourceFolder` is required and must be a registered template folder containing
`sourcePath`. Apply only by repeating the operation with the returned
`approvedDigest`.

To add a host, add a clearly named `assets/<host>/` directory for host-only files, preserve shared skills in `assets/skills/`, declare every shipped path in the harness registry, and keep installer destinations explicit.
