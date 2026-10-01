---
name: write
description: Write a vault note through the contract judge; contract findings come back as warnings, and only a safety refusal denies.
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

Write vault notes with MCP `write {path, content, template?, ifMatch?, check?}`. A note that breaks the contract is saved, with each finding as a `{field, kind}` warning; only a safety refusal denies a write. A saved note with warnings, or a denial, comes with one guidance command. Never ask about or guess the contract's location or values.

Document reads stay on `search { op: "get-document" }`.

## Write

```text
write { path, content, template?, ifMatch?, check? }
```

`path` is vault-relative. `content` is the whole note. `template` names a template in the vault's template folder to scaffold a new note from; omit it to use the one template matching the target folder, if any. A named template that does not exist scaffolds nothing and is reported as `template-missing`. `ifMatch` is the `sha256:` revision of the note you are replacing. `check: true` judges without writing. There are no other fields.

OMS fills only what is mechanical before it judges: template variables such as `{{title}}` and `{{date}}`, date and datetime defaults on a new note, and the chosen template's missing headings. It never invents a value; a flagged value is changed only by a lossless fix, listed in `fixes`.

The judge answers allow or deny, and only a safety refusal denies. Allow writes the note atomically and returns the receipt `{ ok: true, path, revision, contractRevision, index: { keyword, vector }, conformed, missingDefaults, warnings, fixes, next? }`; the note is searchable by keyword in the next call when the vault has an index. A note that breaks the contract is still allowed: each finding is a `warnings` entry, and `next` names the one command to run next; with `contract-open` it is `oms interview`, which the user runs once to seal the vault's folders and properties, so tell the user to run it. To clear a warning, fix the note and write it again with the receipt's revision as `ifMatch`. Deny is for a safety refusal only (a path outside the vault, a control or unsafe path, unsupported input, a tampered contract): it writes nothing and returns `{ ok: false, status: "denied", refusals, violations: [{ field, kind }], reason }`, and `reason` ends with the guidance command. In a sealed vault, when the frontmatter does not parse, the note may be kept as a draft outside the vault instead of saved, and the answer is `{ ok: false, status: "drafted", draftRef, warnings }` (when no draft can be kept, the note is saved with its warnings instead); fix the frontmatter and write again. A finding names a field and a kind only; it never quotes a rule. Do not guess missing values and do not weaken the contract so the note passes; when you cannot fix a finding from what the user gave you, ask.

To replace an existing note, pass its current revision as `ifMatch`: a previous receipt or `write { path, content, check: true }` reports it. Without `ifMatch` the overwrite is refused with `WRITE_IF_MATCH_REQUIRED` and nothing is written; `WRITE_TARGET_CHANGED` means the note moved on, so read it again before retrying; `WRITE_TARGET_ABSENT` means there is no note to replace, so retry without `ifMatch` to create it. `check` also returns the frame for the target (folder meaning, the property and template fields to satisfy, and which may stay absent) and touches nothing on disk.

Placement is explicit: an explicit path, otherwise the folder meaning the user approved, otherwise ask. There is no Inbox fallback.

A vault with no sealed contract accepts any note inside it, with a `contract-open` warning whose `next` is `oms interview`. A contract that cannot be read also accepts the note, with a `contract-unreadable` warning that names `oms interview`. Among contract states, only a tampered contract denies writes, until the user runs `oms doctor contract` at a terminal; the `setup` skill does not recover a broken seal. Paths outside the vault and the vault's control paths are always denied.

## Host file tools

In Claude Code, native writes into the vault go through the same judge in the PreToolUse hook. When the hook cannot reach the judge, it allows the write with one warning and records the failure for `oms doctor contract`. Codex and Hermes declare no write hook, so use MCP `write` for vault notes there.

The surface is four MCP tools (write, search, interview, doctor) and six skills.
