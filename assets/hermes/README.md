# Oh My Second Brain Hermes Adapter

Installed by `oms host install --runtime hermes` into:

- `~/.hermes/skills/knowledge-management/oms/`
- `~/.hermes/config.yaml` as `mcp_servers.oms`

The shared skill bundle contains seven skills: `write`, `search`, `link`,
`distill`, `setup`, `status`, and `doctor`. Runtime operations use the five MCP tools
through `oms serve mcp`.

Hermes takes a skill's category from the first path segment only, so these
skills are listed under `knowledge-management`. Filter with
`skills_list(category="knowledge-management")`; the category
`knowledge-management/oms` matches nothing.

Agents write notes with MCP `write {path, content, template?}`. OMS judges each
note against the contract the user sealed with `oms setup`. A denial returns
only `{field, kind}` and a guidance command. There is no completion operation
and no reviewer protocol, so deciding whether a note is worth keeping and
repairing it belong to the user and the agent. See the [Hermes role guidance](./SOUL.md).

The adapter installs no model provider, no reviewer role, and no daemon.
Installing assets proves only their presence, not that the host loaded them.

Unlike Claude Code (`claude plugin install`), Hermes exposes no native marketplace or plugin-update command, so this adapter stays OMS-managed. `oms package update` updates OMS; `oms host sync --runtime hermes` separately refreshes registrations. Neither upgrades Hermes. `mcp_servers.oms` is edited surgically, leaving the rest of `~/.hermes/config.yaml` — including comments and key ordering — untouched. Existing profiles retain their own configuration and registration scope.
