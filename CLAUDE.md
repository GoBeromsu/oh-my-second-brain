# oh-my-second-brain (OMSB)

AI harness for Obsidian vault guideline enforcement. Structurally constrains Claude Code behavior using deterministic rules.

## Enforcement Model (3-Tier)

- **Tier 1 (Config)**: Deterministic rules from `omsb.config.json` — path boundaries, frontmatter requirements, naming conventions. Severity: block/deny.
- **Tier 2 (Annotations)**: `<!-- omsb: -->` markers in guideline files, extracted at compile time. Severity: block/deny.
- **Tier 3 (Advisory)**: Full guideline text injected into CLAUDE.md context. Severity: advisory only.

## Available Skills

- `/omsb init` — Interactive vault setup. Scans vault, discovers guidelines, generates `omsb.config.json` + `.omsb/rules.json` + `.omsb/CLAUDE.md`. **Run this first.**
- `/omsb compile` — Process raw source notes through the compile pipeline.

## Init-Gated Enforcement

Hooks are always active but enforcement requires initialization:
- Before `/omsb init`: SessionStart advises "Run /omsb init to set up enforcement"
- After `/omsb init`: PreToolUse enforces rules from `.omsb/rules.json`, SessionStart checks staleness

## Hooks

| Event | Matcher | Script | Purpose |
|-------|---------|--------|---------|
| PreToolUse | Write\|Edit\|Bash | guideline-enforcer.mjs | Block/deny/advise based on rules.json |
| PostToolUse | Write\|Edit | authorship-marker.mjs | Auto-mark AI authorship in frontmatter |
| SessionStart | * | session-init.mjs | Check init status + rules.json staleness |
