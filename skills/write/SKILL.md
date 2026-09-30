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

Write vault notes with MCP `write {path, content, template?, ifMatch?, check?}`. A denial gives only `{field, kind}` and a guidance command. Never ask about or guess the contract's location or values.

Document reads stay on `search { op: "get-document" }`.

## Write

```text
write { path, content, template?, ifMatch?, check? }
```

`path` is vault-relative. `content` is the whole note. `template` names a template in the vault's template folder to scaffold a new note from; omit it to use the one template matching the target folder, if any. A named template that does not exist scaffolds nothing and is reported as `template-missing`. `ifMatch` is the `sha256:` revision of the note you are replacing. `check: true` judges without writing. There are no other fields.

OMS fills only what is mechanical before it judges: template variables such as `{{title}}` and `{{date}}`, date and datetime defaults on a new note, and the chosen template's missing headings. It never supplies a required value or changes one the judge would refuse.

The judge answers allow or deny. Allow writes the note atomically and returns the receipt `{ ok: true, path, revision, contractRevision, index: { keyword, vector }, conformed, missingDefaults, warnings, fixes, next? }`; the note is searchable by keyword in the next call when the vault has an index. When `next` is present, the note was saved but has warnings, and `next` names the one command to run next; with `contract-open` it is `oms interview`, which the user runs once to seal the vault's folders and properties, so tell the user to run it. Deny writes nothing and returns `{ ok: false, status: "denied", refusals, violations: [{ field, kind }], reason }`. A violation names a field and a kind only; it never quotes a rule. Read the kinds, fix the note, and write again. Do not guess missing values and do not weaken the contract so the note passes; when you cannot fix a violation from what the user gave you, ask.

To replace an existing note, pass its current revision as `ifMatch`: a previous receipt or `write { path, content, check: true }` reports it. Without `ifMatch` the overwrite is refused with `WRITE_IF_MATCH_REQUIRED` and nothing is written; `WRITE_TARGET_CHANGED` means the note moved on, so read it again before retrying; `WRITE_TARGET_ABSENT` means there is no note to replace, so retry without `ifMatch` to create it. `check` also returns the frame for the target (folder meaning, the property and template fields to satisfy, and which may stay absent) and touches nothing on disk.

Placement is explicit: an explicit path, otherwise the folder meaning the user approved, otherwise ask. There is no Inbox fallback.

A vault with no sealed contract accepts any note inside it, with a `contract-open` warning whose `next` is `oms interview`. A contract that cannot be read also accepts the note, with a `contract-unreadable` warning that names `oms interview`. Only a tampered contract denies writes, until the user runs `oms doctor contract` at a terminal; the `setup` skill does not recover a broken seal. Paths outside the vault and the vault's control paths are always denied.

## Host file tools

In Claude Code, native writes into the vault go through the same judge in the PreToolUse hook. When the hook cannot reach the judge, it allows the write with one warning and records the failure for `oms doctor contract`. Codex and Hermes declare no write hook, so use MCP `write` for vault notes there.

The surface is four MCP tools (write, search, interview, doctor) and six skills.
