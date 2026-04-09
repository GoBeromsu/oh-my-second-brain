# OMSB Philosophy

OMSB exists to make **vault guideline compliance structural**, not aspirational.

## Core ideas

1. **Human guideline docs are the source of truth**
   - The configured guideline folder is where the user expresses policy.
2. **Generated artifacts are helpers, not rivals**
   - `omsb.config.json` stores vault-scoped mappings and registrations.
   - `.omsb/rules.json` is generated operational state.
3. **Explicit rules may be automatic**
   - If a rule is clear, OMSB may enforce it directly.
4. **Ambiguity becomes proposal**
   - If a rule is unclear, OMSB should explain and propose instead of silently mutating the vault.
5. **Vault-local, not global**
   - OMSB is installed broadly through Claude Code, but it activates only for the vault/repo that opted in.
