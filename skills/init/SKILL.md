---
name: init
level: 2
description: Initialize oh-my-second-brain vault enforcement
---

<Purpose>
Interactive setup for oh-my-second-brain. Scans vault structure, discovers guidelines, configures enforcement boundaries, and generates hooks + CLAUDE.md.
</Purpose>

<Steps>
1. Detect vault path (current working directory)
2. Scan vault: find guidelines, detect raw source candidates, sample frontmatter patterns
3. Present scan results and let user confirm/adjust:
   - Guideline directory and files
   - Required guideline domains (folder / frontmatter)
   - Domain-to-file mapping for folder/frontmatter guideline coverage
   - Raw path boundaries
   - `Inbox` fallback for ambiguous routing
   - Managed Obsidian plugins
   - Required frontmatter fields
4. Generate omsb.config.json
5. Compile rules: Tier 1 (config) + Tier 2 (annotations) → .omsb/rules.json
6. Generate .omsb/CLAUDE.md with guideline references
7. Update .claude/CLAUDE.md with @file reference (never overwrite existing content)
8. Report summary: N rules compiled, CLAUDE.md generated
</Steps>

<Tool_Usage>
- Use AskUserQuestion for each confirmation step
- Use explore agent (haiku) to scan vault before asking user
- Use Write tool to create config and CLAUDE.md files
</Tool_Usage>
