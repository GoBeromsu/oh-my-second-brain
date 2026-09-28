---
name: setup
description: Seal the vault contract by reading each template yourself, submitting your interpretation, and asking the owner every setup question. Seals a first or stricter contract only.
---

# setup

Seal the vault contract for the owner without a terminal interview. This is a host recipe skill: it has no MCP tool. It drives `oms setup --questions` and `oms setup --answers <file>`, and the owner answers every question. You never invent, guess, or fill in an answer.

You also supply the one thing OMS cannot read for itself. OMS does not parse template text: a template may be Templater JavaScript, may put a variable where YAML expects a key, and may carry no frontmatter at all, so any mechanical reading of it is untrustworthy. You read each template and submit what it declares with `--interpretations <file>`. That decides which questions exist; every sealed value still comes from the owner's answers, and the owner confirms your interpretation before it is used.

```text
/setup [--reask] [--vault <path>]
```

Always pass the vault with `--vault <path>`. A vault inferred from the current directory is refused.

## Flow

1. Run `oms setup --questions --vault <path>` (add `--reask` only when the owner wants to be asked again about items declined at an earlier seal). When the vault has templates this prints `interpretation-required` with every template source and the `sourceHash` OMS computed for it; go to step 2. Otherwise `status` is `questions`, `questions` lists `{id, prompt, kind, choices?, default?}`, `notes` holds interview lines worth showing the owner, and nothing was sealed.
2. Read each listed source and write one JSON array to a file outside the vault: `{source, observedHash, fields, headings}` per template. `observedHash` is the digest of the bytes you read, and it must equal the `sourceHash` OMS listed, or the run is refused — never copy the listed hash without reading the file. A field is `{name, inferredType, literal, variable}`: `literal` is the fixed value when the template hard-codes one and `null` otherwise, and `variable` is `date`, `datetime`, `title`, `free`, or `null`. A heading is `{title, level, variable}`. Report what the template really declares, including properties a Templater block writes at run time; a field you leave out is a question the owner is never asked. Pass the file as `--interpretations <file>` on every later `--questions` and `--answers` run in this seal.
3. Ask the owner each question with AskUserQuestion, one question at a time, in the order printed. Put the recommended option first: the `default` when there is one, otherwise the first of `choices`. A `confirm` question takes yes or no, a `choice` question takes one of `choices`, and a `text` question takes the owner's own words. When the owner skips a question, leave its id out; never answer for them.
4. Write the answers as one JSON object from question id to answer (`true`/`false` for confirm, the chosen string for choice, a string or number for text) to a temporary file outside the vault, for example under the system temp directory. Run `oms setup --answers <file> --interpretations <file> --vault <path>`.
5. Read the JSON result and loop:
   - `incomplete`: the answers opened follow-up questions, listed in `questions`. Ask those the same way, merge them into the same file, and run `--answers` again. When only `seal` remains, show the owner the `notes` (the contract preview), ask whether to seal, and set `"seal": true` only on a yes.
   - `sealed`: done. Delete the answers file and run `oms doctor contract --vault <path>` to confirm the seal.
   - `rejected`: the diagnostic names the question id and why (`CONTRACT_ANSWER_INVALID`, `CONTRACT_ANSWER_UNKNOWN`, `CONTRACT_ANSWERS_INVALID`). Ask the owner that question again and rerun. Nothing was sealed.
   - `loosening`: the answers would loosen the sealed contract. `changes` names each field and kind of change, never a value. Nothing was sealed. Tell the owner that only they can loosen a contract, by running `oms setup` themselves in a terminal. Do not retry with other answers to get around it. A `template-tightened` change means the answers make a sealed template stricter; that is refused too, because the judge enforces a template relative to the note's previous content, so a stricter template would stop checking notes that fail it. A `pattern-unsafe` change means a sealed pattern that today's seal screen refuses (for example one over the length limit); only the owner's terminal `oms setup` can replace it, and it asks for just that rule again.
   - `interpretation-required`: a template source carries no interpretation. Go back to step 2 for every source listed.
   - `interpretation-rejected`: the owner did not confirm your interpretation of the templates in `templates`. Read those templates again, correct what you got wrong, and submit a new interpretation. This is not a refusal and nothing was sealed; do not re-submit the same interpretation to get a different answer.
   - `refused`: the seal needs recovery, or your interpretation does not match the sources. `reasons` names each one: an unknown source, a source left uninterpreted, a template read from bytes the file no longer holds (read it again and resubmit), or two templates that would share a name. For anything else, tell the owner to run `oms doctor contract`, then `oms setup` themselves in a terminal.
   - `aborted`: the owner declined to seal. Nothing was sealed.

## Rules

- The answers file and the interpretations file are the only files you write. Keep both outside the vault (either one inside the vault is refused) and delete them when the run ends.
- Never put `sourceHash` in an interpretation, and never copy the hash OMS printed into `observedHash` without reading the file. OMS computes the hash it stores; `observedHash` exists only to prove you read the bytes that are there now, and that check is what stops a changed template from sealing as unchanged.
- The interpretation is what you read, not what you would prefer the contract to say. Leaving a field or heading out silently removes its question, which weakens the contract without the owner ever being asked.
- Never read, list, or edit `~/.oms` or any sealed contract file. The CLI output is the whole interface.
- The values the owner gives (allowed values, patterns, ranges) are part of the hidden contract. Do not repeat them into notes, messages to others, or memory.
- `--answers` seals a first contract, or a reseal that only adds or tightens. Removing a folder, property, or template, dropping a requirement, or widening a rule is loosening, and it belongs to the owner's own terminal.
- The reseal may add new folders, properties, and templates, and tighten folder and property rules. Changing an existing sealed template, even to make it stricter, needs `oms setup` in the owner's terminal: the judge enforces templates relative to the previous content, so a stricter template stops checking notes that fail it. When a template's source changed, answer its questions exactly as before.
- Adding is allowed but is not neutral: registering a new folder, property, or template widens that closed axis, so notes the sealed contract refused there can be written afterwards. Ask the owner about every addition; never add one they did not answer for.
- A write denied as `unregistered-folder` or `unknown-property` is not yours to clear. Do not create the folder, add the type to `.obsidian/types.json`, or answer the registration question yourself so that the write passes. Ask the owner, and register the folder or property only when they answer. Nothing but that answer enforces this.
- Never run `oms setup` without `--questions` or `--answers`. The interactive interview is the owner's, in their own terminal.
- Never run setup under a pseudo-terminal wrapper such as `script`, `expect`, or `unbuffer`, and never set up a terminal for it. The interactive gate only checks for a TTY, so a wrapper would take the owner's full authority, including loosening.
- Never move or rename the vault with Bash, and never delete, edit, or re-ID `.oms/settings.json`. Either makes the vault look never sealed, so `--answers` would take a fresh first seal in place of the owner's contract.

The surface is four MCP tools (write, search, interview, doctor) and six skills.
