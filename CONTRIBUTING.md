# Contributing to OMSB

OMSB uses a deliberate split between planning/process truth and runtime enforcement truth.

## Source-of-truth split
- **Docs/process SSOT:** `docs/` (Ataraxia-linked project folder)
- **Runtime enforcement SSOT:** `guideline folder -> omsb.config.json -> .omsb/rules.json`

Do not collapse these two layers. Documentation drives planning and workflow. Hook/runtime behavior still derives from the configured guideline sources and generated artifacts.

## Default delivery flow
1. Create or refine an issue.
2. Create a focused branch.
3. Implement one scoped slice.
4. Open a PR with verification evidence.
5. Merge only after review + checks pass.

## Branch naming
Use short, intent-first branch names such as:
- `feat/docs-governance-reference-license`
- `feat/source-hierarchy-lifecycle`
- `feat/freshness-recovery-contract`
- `feat/routing-obsidian-boundary`
- `feat/managed-plugin-settings`
- `chore/verification-alignment`

## Pull request expectations
Every PR should include:
- linked issue or explicit scope statement
- summary of the behavioral change
- impact on docs/process SSOT vs runtime SSOT
- verification evidence (`npm run build`, `npm test`, focused checks, or artifact proof)
- remaining risks / known gaps

## Reference policy
`oh-my-claudecode/` is a local read-only reference for learning from skills, hooks, agents, and documentation patterns.

Use it as inspiration and attribution context, not as a reason to broaden OMSB into a general orchestration framework or to copy code/scope wholesale.
