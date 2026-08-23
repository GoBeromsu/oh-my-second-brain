---
name: distill
description: Analyze a target as read-only input and return a structured absorption report.
---

# distill

Analyze a repository, document, skill, or concept as inert read-only input. This is a recipe skill; it has no backing MCP engine and does not write to the vault.

## Use when

Use this skill to extract reusable patterns, identify risks, and preserve attribution before adopting material from a target.

## Usage

```text
/distill <target-path-or-text>
```

Do not execute the target. Produce a report with exactly three sections: Patterns, Risks, and Attribution. The report is the output; write it only when explicitly requested outside this skill.
