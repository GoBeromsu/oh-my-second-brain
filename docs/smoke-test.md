# OMSB Smoke Test

Use this checklist to validate a fresh OMSB install against a **sanitized demo vault**.

Before starting, review:
- [docs/demo-guide.md](demo-guide.md)
- [docs/demo-vault-template/README.md](demo-vault-template/README.md)

## Preconditions

- Claude Code plugin installed
- working inside a sanitized demo vault only
- no personal note titles, usernames, emails, or private paths visible

## Smoke Test Flow

### 1. Initialize the vault
Run:

```text
/omsb init
```

Expected:
- OMSB asks for or confirms the guideline folder
- OMSB confirms folder/frontmatter guideline mapping
- OMSB allows `Inbox` fallback configuration
- OMSB can register a managed plugin
- `omsb.config.json` is created
- `.omsb/rules.json` is created

### 2. Check generated artifacts
Verify that these exist:
- `omsb.config.json`
- `.omsb/rules.json`
- `.omsb/CLAUDE.md`

### 3. Terminology routing
Run:

```text
/omsb terminology
```

Expected:
- explicit routing if guideline target exists
- `Inbox` fallback if no explicit target exists
- proposal behavior if routing is ambiguous

### 4. Managed plugin settings
Run:

```text
/omsb plugin-settings
```

Expected:
- reads plugin-owned `data.json`
- does not attempt to modify plugin source, CSS, or JS
- guideline-explicit change may auto-apply
- optimization-only change should request approval

### 5. Stale guideline refresh
Change one guideline file in the demo vault, then start a fresh session or rerun the workflow.

Expected:
- OMSB detects stale guideline state
- OMSB does not silently continue with stale enforcement assumptions
- OMSB instructs you to rerun:

```text
/omsb init
```

### 6. Compile flow (secondary check)
Run:

```text
/omsb compile
```

Expected:
- compile command runs as a secondary product check
- this is not required for the first public demo, but should still remain available

## Pass Criteria

A smoke test passes when:
- init succeeds
- generated files exist
- terminology routing behaves as `explicit | inbox | propose`
- plugin-settings respects the `data.json`-only boundary
- stale guideline state is detected and surfaced

## Privacy Check Before Sharing Results

Before publishing screenshots, GIFs, or logs from the smoke test, re-check:
- no personal note titles
- no personal vault paths
- no usernames or emails
- no private plugin data
- no secrets or tokens
