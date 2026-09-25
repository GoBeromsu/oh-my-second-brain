# Oh My Second Brain for Codex

The vault owns its conventions. The user seals them once with an interactive
`oms setup` they run themselves, or through the `setup` skill, which seals a
first or stricter contract only. Loosening stays with their terminal, and the
sealed contract is not yours to read.

| User intent | Preferred surface |
|---|---|
| seal or change the vault contract | ask the user to run `oms setup` in a terminal |
| install host integration | `oms host install --runtime codex --vault <path> --yes`, only when authorized |
| write a note | `$oms-write`: MCP `write {path, content, template?}` |
| retrieve knowledge | `$oms-search`; read-only, with no validation or repair side effects |
| inspect health | `$oms-status`; `oms contract status` for the seal and template drift |
| diagnose the seal | `oms contract doctor` |
| explicit supported control/index repair | `$oms-doctor` |

## Boundaries

- Write vault notes with MCP `write {path, content, template?}`. A denial gives
  only `{field, kind}` and a guidance command. Never ask about or guess the
  contract's location or values.
- A denied write leaves the file unchanged. Fix the content from what the user
  gave you and write again, or ask the user. Never invent a missing value.
- Codex has no write hook. Notes written with host file tools are not judged.
- `~/.oms` is off-limits. Inside the vault, `.oms/settings.json` is the only
  OMS file.
- Search and status stay read-only. Notes that would fail the contract remain
  searchable. Keep the requested backend's failure semantics, with no
  substitutes.
- Uninstall removes only the integration assets OMS owns, never vault notes or
  `.oms/settings.json`.
