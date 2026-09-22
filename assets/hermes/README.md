# Oh My Second Brain Hermes Adapter

Installed by `oms host install --runtime hermes` into:

- `~/.hermes/skills/knowledge-management/oms/`
- `~/.hermes/config.yaml` as `mcp_servers.oms`

The shared skill bundle contains `write`, `search`, `link`, `distill`, `status`,
`doctor`, and tool-less `template` and `interview`; runtime operations use the
five MCP tools through `oms serve mcp`.

Agents write notes; OMS guides, checks saved bytes, and judges completion.
Semantic review uses a fresh `delegate_task` conversation with approved criteria,
authorized evidence, and explicit non-mutation instructions. Inherited tools
remain visible as an **instruction-only** boundary, not unsupported delegation
and not enforced isolation. A real terminal result and unchanged input snapshots
are required; writer self-PASS, failed delegation, and insufficient evidence
cannot complete a task. See the [Hermes role guidance](./SOUL.md) and
[native delegation documentation](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/delegation.md).

The adapter does not install a model provider or reviewer daemon. Installing
assets proves only their presence, not that the host launched a separate reviewer.

Unlike Claude Code (`claude plugin install`), Hermes exposes no native marketplace or plugin-update command, so this adapter stays OMS-managed. `oms package update` updates OMS; `oms host sync --runtime hermes` separately refreshes registrations. Neither upgrades Hermes. `mcp_servers.oms` is edited surgically, leaving the rest of `~/.hermes/config.yaml` — including comments and key ordering — untouched. Existing profiles retain their own configuration and registration scope.
