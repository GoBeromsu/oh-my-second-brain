# Oh My Second Brain Vault Convention — SSOT for Host Agents

This file defines the end-user vault convention for host agents (Claude Code, Codex,
Hermes, and others). The vault's meaning belongs to the user.

## The Sealed Contract

The user states what the vault means once, by running the interactive `oms setup` at
a terminal. The interview covers folders, the property pool, and the templates in the
template folder together, and seals the result as the vault contract. The interactive
interview refuses to run without a terminal or under `OMS_NON_INTERACTIVE=1`. An agent
seals only through the `setup` skill: `oms setup --questions` prints the questions, the
agent asks the owner each one, and `oms setup --answers <file>` seals a first or stricter
contract. A reseal that loosens is refused there and belongs to the terminal. There is no
MCP operation for setup.

- The sealed contract lives outside the vault under `~/.oms/`. That directory is
  off-limits: do not read, search, or write anything under it.
- The only OMS file inside the vault is `.oms/settings.json`. Do not write under
  `.oms/`.
- Templates in the template folder are the user's own Markdown. Read them to see a
  note's shape; do not rewrite them.
- `.obsidian/types.json` is a read-only observation. Do not modify it.

## Writing Notes

- Write notes with the MCP `write` tool: `{path, content, template?}`, where
  `content` is the whole note and `template` optionally names the sealed template
  the note follows. In Claude Code, native edits inside the vault are judged the
  same way by the guard hook.
- A denied write leaves the file unchanged and returns `{field, kind}` violations
  and one guidance command. Fix the note and write it again; do not look for the
  rule values.
- Use only the properties the vault declares; a key outside the sealed property
  pool is denied. Keep existing frontmatter values you were not asked to change.
- Replace every template variable with a real value before writing.
- A `contract-unreadable` denial means the seal no longer matches the vault. Ask
  the user to run `oms setup`; do not work around it.

## User Ownership

An allowed write means the note fits the sealed structure, not that it is worth
keeping. Deciding that belongs to the user. Oh My Second Brain does not impose a
folder structure, hardcode property names, or replace user-authored meaning.

## Quick Reference for Host Agents

- For note shape, read the applicable template in the vault's template folder.
- For the sealed folders, property names and types, and templates, use MCP
  `search` with `op: "templates"`.
- For contract health, run `oms status` or `oms contract doctor`, or ask the user.
- When in doubt, preserve user-authored content.
