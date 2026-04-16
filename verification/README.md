# Runtime Verification Runbooks

These runbooks cover the remaining verification areas that are not fully proven by the repository's local smoke tests.

## Scope
- Real Claude Code session verification — see [claude-code-session.md](./claude-code-session.md)
- Real Obsidian native adapter / CLI verification — see [obsidian-native.md](./obsidian-native.md)

## Why these exist
The repository now has strong local coverage for:
- config / rules / governance generation
- hook scripts
- routing / proposal behavior
- plugin settings workflows
- bootstrap/runtime script behavior

What still needs real-environment evidence is the live runtime path:
- Claude Code invoking `/omsb ...` end to end
- Obsidian-native execution for user-visible note operations

## Related tracking
- Issue #8 — real Claude Code session verification
- Issue #9 — live Obsidian native adapter or CLI verification

## Evidence standard
When using these runbooks, collect:
- sanitized transcripts or screenshots
- resulting generated artifacts (`omsb.config.json`, `.omsb/rules.json`, `.omsb/CLAUDE.md`)
- notes on any mismatch vs local smoke-test expectations
- follow-up issues for runtime-only bugs
