---
name: setup
description: Seal the vault contract's folders and properties by asking the owner every setup question. Seals a first or stricter contract only.
---

# setup

Seal the vault contract for the owner without a terminal interview. This is a host recipe skill: it has no MCP tool. It drives `oms setup --questions` and `oms setup --answers <file>`, and the owner answers every question. You never invent, guess, or fill in an answer.

The contract covers folders and properties only. Templates are not part of it: they live in the vault's `templateFolder`, scaffold new notes at write time, and are never sealed or judged, so setup asks nothing about them. `oms setup extract --template <name> --vault <path>` previews what one template would scaffold (its source, `folder:` selector, property names, and headings) when the owner wants to check it.

```text
/setup [--reask] [--vault <path>]
```

Always pass the vault with `--vault <path>`. A vault inferred from the current directory is refused.

## Flow

1. Run `oms setup --questions --vault <path>` (add `--reask` only when the owner wants to be asked again about items declined at an earlier seal). `status` is `questions`, `questions` lists `{id, prompt, kind, choices?, default?}`, `notes` holds interview lines worth showing the owner, and nothing was sealed.
2. Ask the owner each question with AskUserQuestion, one question at a time, in the order printed. Put the recommended option first: the `default` when there is one, otherwise the first of `choices`. A `confirm` question takes yes or no, a `choice` question takes one of `choices`, and a `text` question takes the owner's own words. When the owner skips a question, leave its id out; never answer for them.
3. Write the answers as one JSON object from question id to answer (`true`/`false` for confirm, the chosen string for choice, a string or number for text) to a temporary file outside the vault, for example under the system temp directory. Run `oms setup --answers <file> --vault <path>`.
4. Read the JSON result and loop:
   - `incomplete`: the answers opened follow-up questions, listed in `questions`. Ask those the same way, merge them into the same file, and run `--answers` again. When only `seal` remains, show the owner the `notes` (the contract preview, and a `CONTRACT_LEGACY_TEMPLATES_DROPPED` line when an older seal held templates that this seal does not carry forward), ask whether to seal, and set `"seal": true` only on a yes.
   - `sealed`: done. Delete the answers file and run `oms doctor contract --vault <path>` to confirm the seal.
   - `rejected`: the diagnostic names the question id and why (`CONTRACT_ANSWER_INVALID`, `CONTRACT_ANSWER_UNKNOWN`, `CONTRACT_ANSWERS_INVALID`). Ask the owner that question again and rerun. Nothing was sealed.
   - `loosening`: the answers would loosen the sealed contract. `changes` names each field and kind of change, never a value. Nothing was sealed. Tell the owner that only they can loosen a contract, by running `oms setup` themselves in a terminal. Do not retry with other answers to get around it. A `pattern-unsafe` change means a sealed pattern that today's seal screen refuses (for example one over the length limit); only the owner's terminal `oms setup` can replace it, and it asks for just that rule again.
   - `refused`: the seal cannot proceed; `reasons` names each one. Tell the owner to run `oms doctor contract`, then `oms setup` themselves in a terminal.
   - `aborted`: the owner declined to seal. Nothing was sealed.

## Rules

- The answers file is the only file you write. Keep it outside the vault (an answers file inside the vault is refused) and delete it when the run ends.
- Never read, list, or edit `~/.oms` or any sealed contract file. The CLI output is the whole interface.
- The values the owner gives (allowed values, patterns, ranges) are part of the hidden contract. Do not repeat them into notes, messages to others, or memory.
- `--answers` seals a first contract, or a reseal that only adds or tightens. Removing a folder or property, dropping a requirement, or widening a rule is loosening, and it belongs to the owner's own terminal.
- The reseal may add new folders and properties, and tighten folder and property rules. Editing a template needs no reseal: it takes effect on the next write.
- Adding is allowed but is not neutral: registering a new folder or property widens that closed axis, so notes the sealed contract flagged there are saved without that warning afterwards. Ask the owner about every addition; never add one they did not answer for.
- An `unregistered-folder` or `unknown-property` warning on a write is not yours to clear. Do not create the folder, add the type to `.obsidian/types.json`, or answer the registration question yourself so that the warning goes away. Ask the owner, and register the folder or property only when they answer. Nothing but that answer enforces this.
- Never run `oms setup` without `--questions` or `--answers`. The interactive interview is the owner's, in their own terminal.
- Never run setup under a pseudo-terminal wrapper such as `script`, `expect`, or `unbuffer`, and never set up a terminal for it. The interactive gate only checks for a TTY, so a wrapper would take the owner's full authority, including loosening.
- Never move or rename the vault with Bash, and never delete, edit, or re-ID `.oms/settings.json`. Either makes the vault look never sealed, so `--answers` would take a fresh first seal in place of the owner's contract.

The surface is four MCP tools (write, search, interview, doctor) and six skills.
