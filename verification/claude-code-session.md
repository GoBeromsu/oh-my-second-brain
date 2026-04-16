# Runbook — Verify OMSB inside a real Claude Code session

Related issue: #8

## Goal
Verify that OMSB behaves correctly when invoked from a real Claude Code session, not just through local script or test harnesses.

## Preconditions
- a sanitized demo vault (no private notes or secrets)
- Claude Code installed and able to load OMSB
- repository state checked out at the branch/commit under review
- ability to collect screenshots or copy sanitized terminal output

## Suggested setup
1. Open the demo vault directory in a terminal.
2. Ensure OMSB is installed/available in Claude Code.
3. Start a fresh Claude Code session in the demo vault.
4. Confirm no stale `omsb.config.json` / `.omsb/rules.json` artifacts are accidentally inherited from an unrelated run.

## Verification sequence

### A. `/omsb init`
1. Run `/omsb init`.
2. Confirm the session proposes or detects the guideline folder.
3. Confirm folder/frontmatter guideline files can be mapped.
4. Confirm `Inbox` fallback and managed plugin registration prompts/steps work.
5. Verify artifacts exist afterward:
   - `omsb.config.json`
   - `.omsb/rules.json`
   - `.omsb/CLAUDE.md`
   - `.claude/CLAUDE.md` with `@file .omsb/CLAUDE.md`

### B. `/omsb terminology`
1. Prepare at least one explicit-routing case.
2. Prepare at least one ambiguous-routing case.
3. Run `/omsb terminology` in both scenarios.
4. Verify expected behavior:
   - explicit → resolved destination
   - inbox → configured fallback
   - ambiguous → proposal artifact, not silent mutation

### C. `/omsb plugin-settings`
1. Use a managed plugin with a real `data.json`.
2. Run `/omsb plugin-settings` for:
   - one guideline-explicit change
   - one optimization-only change
3. Verify expected behavior:
   - explicit change can be auto-applied
   - optimization-only change yields a proposal / approval path
   - no source/CSS/JS files are touched

## Evidence to capture
- screenshot or transcript of each command invocation
- before/after snapshots of generated config/rules/plugin `data.json`
- exact mismatch notes if Claude runtime behavior differs from the local smoke tests

## Pass criteria
- `/omsb init` succeeds end to end at least once
- `/omsb terminology` shows correct explicit / inbox / propose behavior
- `/omsb plugin-settings` respects explicit-vs-approval boundaries
- any runtime-only defect is recorded as a follow-up issue

## Failure handling
If any step fails:
1. save the exact command transcript or screenshot
2. collect the generated artifacts present at failure time
3. file a focused follow-up issue with reproduction steps
