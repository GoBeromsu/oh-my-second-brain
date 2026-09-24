---
name: template
description: Shape user-owned template contracts. Changes go through the interview skill. OMS does not render notes or execute Templater.
---

# template

Turn a note design into a user-owned contract. People and agents share that contract. Writing a note is `/write`. Changing the contract is `/interview`.

## Authority

- `.oms/template-policy.json` version 4 is the approved structural and semantic authority. Version 3 is unsupported; do not convert it or read it with a compatibility fallback.
- The property pool holds type, intent, allowed values, and format. A default or individual layer only points at a pool property, adds a requirement, or narrows allowed values. It cannot override type, intent, or format, and it cannot weaken a default requirement, heading, or order. A contradiction is a contract conflict, not a silent overwrite.
- The default template starts empty and always applies. An unbound note uses only that default. Do not invent required keys, headings, or criteria, and do not offer a default opt-out.
- `.oms/taxonomy.json` owns placement and link intent. Resolve a destination from an explicit path or folder, then the template placement, then a question. There is no Inbox fallback.
- `.obsidian/types.json` is a read-only observation. A type conflict is a separate diagnostic; the v4 contract still decides.
- `.obsidian/types.json` is Obsidian's own read-only type file. OMS reads it and never writes it, and it is not the contract authority.
- Approved Markdown lives in the policy snapshot. Draft or source drift does not approve new meaning. Guide and check keep using the last approved bytes and report drift for that template only. Other templates and search continue. A damaged policy snapshot is unverifiable; do not replace it with an empty contract.

## Source syntax

The agent reads Templater or any other source syntax and proposes ordinary Markdown plus an explicit contract. OMS does not parse or execute `tp`, JavaScript, or a private token language, and it has no note renderer. Keep unmanaged frontmatter. Leave original source bytes where they are; contract review verifies them and does not rewrite them. Selecting a folder is an explicit interview decision, not a setup decision, not a per-file registration, and not a contract guess. One sample value does not become a rule.

## Notice

Census of selected sources is read-only: `search { op: "template-scan" }` or `oms template scan`. The first notice is exactly `템플릿에 변경이 있습니다`, with exactly `확인하기` and `나중에` and no template name, hash, or change list. `나중에` is host-only and does not touch the interview ledger. `확인하기` starts `/interview`. It does not write source bytes or block search. Long-lived sessions still surface a `templateNotice` on write, search, and status when boot instructions are stale.

## Reads

```text
oms template list|show|scan|check
```

`scan`, `list`, `show`, and `check` are read-only. `regenerate-types` republishes the derived projection only, through its dry-run and the exact returned `approvalDigest` submitted as `approvedDigest`. `review`, `answer`, and `commit` belong to `/interview`. Do not self-approve, and do not edit policy, taxonomy, or `.oms/types.json` directly.

## Surface

The template modes are `publish-contract`, `review-sources`, `acknowledge-source`, and `relink-source`. Creating, updating, moving, removing, reclassifying, defaulting, and folder registration do not exist, on either MCP or the CLI, and neither does a renderer or an interview ledger. Every contract change goes through `/interview`, which agrees the document with the user and then publishes it.
