---
name: omsb terminology
description: Create or route terminology notes with guideline-derived destinations
---

<Purpose>
Create or relocate terminology notes without hard-coded vault paths. Uses one routing contract that returns: explicit destination, `Inbox` fallback, or proposal-required.
</Purpose>

<Rules>
- Prefer Obsidian-native CLI/plugin operations for user-visible moves
- If the destination is ambiguous, do not guess — produce a proposal
- Use `Inbox` only as the configured fallback, not as a default raw-source assumption
</Rules>

<Steps>
1. Load routing config/rules for `terminology`
2. Resolve destination with the routing contract
3. If destination is explicit, create/move the note there
4. If destination is `Inbox`, create/move it to `Inbox`
5. If destination is `proposal`, explain the ambiguity and generate a proposal artifact
</Steps>
