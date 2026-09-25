---
name: write
description: Write a vault note through the contract judge; a denied write names each violation.
mcp_tool: write
mcp_args:
  path: "$1"
  content: "$2"
---

# write

The user owns meaning. The agent writes the note. OMS judges the bytes against the vault's sealed contract before they reach disk and does not judge whether the writing is good.

```text
/write <note-path> [template]
```

Write vault notes with MCP `write {path, content, template?}`. A denial gives only `{field, kind}` and a guidance command. Never ask about or guess the contract's location or values.

Document reads stay on `search { op: "get-document" }`.

## Write

```text
write { path, content, template? }
```

`path` is vault-relative. `content` is the whole note. `template` names a sealed template when the note follows one; omit it otherwise. There are no other fields.

The judge answers allow or deny. Allow writes the note atomically and returns `{ ok: true, path }`. Deny writes nothing and returns `{ ok: false, violations: [{ field, kind }], reason }`. A violation names a field and a kind only; it never quotes a rule. Read the kinds, fix the note, and write again. Do not guess missing values and do not weaken the contract so the note passes; when you cannot fix a violation from what the user gave you, ask.

Placement is explicit: an explicit path, otherwise the folder meaning the user approved, otherwise ask. There is no Inbox fallback.

A vault with no sealed contract accepts any note inside it. A contract that cannot be read denies writes until the user restores it with `oms setup` at a terminal; the `setup` skill does not recover a broken seal. Paths outside the vault and the vault's control paths are always denied.

## Host file tools

In Claude Code, native writes into the vault go through the same judge in the PreToolUse hook. When the hook cannot reach the judge, it allows the write with one warning and records the failure for `oms contract doctor`. Codex and Hermes declare no write hook, so use MCP `write` for vault notes there.

The surface is five MCP tools and seven skills.
