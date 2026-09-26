# Oh My Second Brain Hermes Adapter

Installed by `oms host install --runtime hermes` into:

- `~/.hermes/skills/knowledge-management/oms/`
- `~/.hermes/config.yaml` as `mcp_servers.oms`

The shared skill bundle contains seven skills. Hermes resolves skills by bare
name across every installed bundle, so the installer copies them with an `oms-`
prefix in both the directory and the frontmatter `name`: `oms-write`,
`oms-search`, `oms-link`, `oms-distill`, `oms-setup`, `oms-status`, and
`oms-doctor`. The shared sources and the other hosts keep the unprefixed names.
`SKILL_CAPABILITY_GUIDE.md` in the same directory maps each skill to its MCP
tool or marks it as an agent recipe. Runtime operations use the five MCP tools
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
