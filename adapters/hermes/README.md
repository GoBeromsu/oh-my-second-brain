# Oh My Second Brain Hermes Adapter

Installed by `oms install --runtime hermes` into:

- `~/.hermes/skills/knowledge-management/oms/`
- `~/.hermes/config.yaml` as `mcp_servers.oms`

The skill bundle mirrors Oh My Second Brain's write/retrieve/setup/doctor lifecycle and uses the Oh My Second Brain MCP server for runtime operations.

Unlike Claude Code (`claude plugin install`), Hermes exposes no native marketplace or plugin-update command, so this adapter stays OMS-managed: `oms update` reconciles it by re-running the same install path. `mcp_servers.oms` is edited surgically, leaving the rest of `~/.hermes/config.yaml` — including comments and key ordering — untouched.
