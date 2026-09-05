# Oh My Second Brain Hermes Adapter

Installed by `oms host install --runtime hermes` into:

- `~/.hermes/skills/knowledge-management/oms/`
- `~/.hermes/config.yaml` as `mcp_servers.oms`

The shared skill bundle contains `write`, `search`, `link`, `distill`, `status`, `doctor`, and tool-less `template`; runtime operations use the five MCP tools through `oms serve mcp`.

Unlike Claude Code (`claude plugin install`), Hermes exposes no native marketplace or plugin-update command, so this adapter stays OMS-managed. `oms package update` updates OMS; `oms host sync --runtime hermes` separately refreshes registrations. Neither upgrades Hermes. `mcp_servers.oms` is edited surgically, leaving the rest of `~/.hermes/config.yaml` — including comments and key ordering — untouched. Existing profiles retain their own configuration and registration scope.
