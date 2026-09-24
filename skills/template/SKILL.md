---
name: template
description: Shape user-owned template contracts. Changes go through the interview skill. OMS does not render notes or execute Templater.
---

# template

Turn a note design into a user-owned contract. People and agents share that contract. Writing a note is `/write`. Changing the contract is `/interview`.

## Authority

- `.oms/template-policy.json` version 5 is the published contract and the only structural authority. A historical version 3 or 4 policy is still readable, and a mutating selection migrates it in place while preserving its recorded meaning; a held or unproved historical contract is reported `review-required` instead of being rewritten.
- The property pool holds type, intent, allowed values, and format. The common contract and each registration point at pool properties. A registration inherits the common contract and may also relax it, because the user can approve a relaxation for one template; what it cannot do is invent meaning the published document does not contain.
- A closed value set exists only when the document declares `valuePolicy: "closed"`. A list of allowed values on its own stays a suggestion and never becomes a filter.
- The common contract always applies and has no Markdown file of its own. A note with no registered template is valid under the common contract alone. Do not invent required keys, headings, or criteria, and do not offer a common-contract opt-out.
- `.oms/taxonomy.json` owns placement and link intent. Resolve a destination from an explicit path or folder, then the template placement, then a question. There is no Inbox fallback.
- `.obsidian/types.json` is Obsidian's own read-only type file. OMS reads it and never writes it. A type conflict is a separate diagnostic; the published contract still decides.
- A registered source stays the user's original Markdown file. The contract records its path and content hash; OMS never rewrites it, copies it, or keeps an approved snapshot of its bytes. A changed hash is drift evidence, not new approved meaning: selecting that registration is refused with `SOURCE_DRIFT` until the user reviews and acknowledges the new bytes, while the common contract, every other registration, and search continue. A policy that cannot be read is reported unreadable, never replaced with an empty contract.

## Source syntax

The agent reads Templater or any other source syntax and proposes ordinary Markdown plus an explicit contract. OMS does not parse or execute `tp`, JavaScript, or a private token language, and it has no note renderer. Keep unmanaged frontmatter. Leave original source bytes where they are; source review verifies them and does not rewrite them. Selecting a folder is an explicit interview decision, not a setup decision, not a per-file registration, and not a contract guess. One sample value does not become a rule.

## Notice

Discovery of candidate sources is read-only: `search { op: "template-scan" }` or `oms template scan`. Discovery is not registration and not approval. The first notice is exactly `템플릿에 변경이 있습니다`, with exactly `확인하기` and `나중에` and no template name, hash, or change list. `나중에` is host-only and makes no server call. `확인하기` starts `/interview`. It does not write source bytes or block search. Long-lived sessions still surface a `templateNotice` on write, search, and status when boot instructions are stale.

## Reads

```text
oms template list|show|scan|check
```

`list`, `show`, `scan`, and `check` are read-only. `check` diagnoses the published policy, the vault settings, held registrations, and each registered source without repairing anything. A rendered contract and the source state shown beside it come from one snapshot, proven by the returned policy digest. Do not edit policy, taxonomy, or `.oms/types.json` directly, and do not self-approve.

## Surface

The template modes are `publish-contract`, `review-sources`, `acknowledge-source`, and `relink-source`. `review-sources` is read-only and takes no transaction id; the three mutations each require an explicit `transactionId`. Publication previews without `--yes` and compare-and-swaps against the exact bytes now on disk, so a valid hand-edited policy stays revisable. Acknowledgment needs the live digest and advances only the recorded hash. Relinking needs a genuinely missing original and a candidate path the user spells out exactly. Creating, updating, moving, removing, reclassifying, defaulting, and folder registration do not exist, on either MCP or the CLI, and neither does a renderer, an interview ledger, or a derived-projection republish. Every contract change goes through `/interview`, which agrees the document with the user and then publishes it.
