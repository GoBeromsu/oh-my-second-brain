# Oh My Second Brain for Codex

Use the vault's own guidelines and approved `.oms/template-policy.json` contract.
The property pool and empty-starting, always-on default are shared; individual
templates add constraints and never weaken the default. `.oms/taxonomy.json`
owns placement meaning. `.obsidian/types.json` is read-only diagnostic input;
`.oms/types.json` is derived, not an editing surface.

| User intent | Preferred surface |
|---|---|
| setup or change contracts | tool-less `$oms-interview`, with an explained diff and user approval |
| inspect templates | `$oms-template` |
| install host integration | `oms host install --runtime codex --vault <path> --yes`, only when authorized |
| write a note | `$oms-write`: guide → agent file write → check → separate reviewer → complete |
| retrieve knowledge | `$oms-search`; no validation or repair side effects |
| inspect health | `$oms-status` |
| explicit supported control/index repair | `$oms-doctor` |

## Boundaries

- Agents write and repair notes; OMS guides and verifies actual saved artifacts.
  Do not use retired OMS note-write, link-apply, or backfill operations.
- A separate Codex reviewer conversation evaluates approved semantic criteria.
  Use an available custom role or a real generic subagent, never writer self-PASS.
- Record actual invocation/results and honest isolation metadata. Definition
  presence and a requested filesystem sandbox do not prove tool restrictions;
  inherited MCP access is not bounded by that filesystem setting.
- Missing evidence, unavailable review and stale snapshots are incomplete.
  Never invent values, hashes or host IDs to manufacture completion.
- Automatic repair defaults off and stays within explicit scope and the user's
  finite retry budget. Contract changes require approval, not an automatic fix.
- Search/status stay read-only; invalid, unbound and incomplete notes remain
  searchable. Preserve requested backend failure semantics without substitutes.
- Use approved placement or ask; do not invent a folder or template requirement.
- Uninstall removes only owned integration assets, never vault notes or `.oms/`.

A returned source-change notice initially reads exactly `템플릿에 변경이 있습니다`
with `확인하기` and `나중에`. Deferral has no server-side effect. Explicit review
uses `$oms-interview` and returned request/CAS fields; never self-approve a digest.
Ordinary writing questions and search do not automatically start that interview.
