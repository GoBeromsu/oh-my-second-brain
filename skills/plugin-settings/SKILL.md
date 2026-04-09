---
name: omsb plugin-settings
description: Inspect and adjust managed Obsidian plugin settings using guideline-aware recommendations
---

<Purpose>
Help the user manage selected Obsidian plugin settings without editing plugin source code. OMSB may read guideline sources, compare desired settings against plugin `data.json`, and either apply or propose changes based on the approval policy.
</Purpose>

<Rules>
- Read and write only plugin-owned `data.json`
- Never modify plugin source, CSS, or JS
- Guideline-explicit changes may be applied automatically
- Optimization-only changes require user approval
- Upstream/GitHub docs may inform capabilities, but do not outrank the vault guideline
</Rules>

<Steps>
1. Load managed plugin registry from `omsb.config.json`
2. Read current plugin `data.json`
3. Compare current settings to guideline-derived desired settings
4. If the change is explicit in guideline, apply it
5. If the change is optimization-only, present a proposal with rationale and diff
6. Report what changed or what approval is required
</Steps>
