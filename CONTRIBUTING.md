# Contributing

## Documentation coverage

Keep implementation and contributor-facing documentation in the same change. The five source layers are authoritative; when a layer changes, review the mapped documents and update the layer's unreleased changelog section.

| Source layer | What lives there | Review and update | Changelog layer |
| --- | --- | --- | --- |
| `src/kernel/` | Domain model, search contracts, harnesses, and shared runtime behavior | `docs/architecture.md`, `docs/conventions.md`, relevant ADRs in `docs/decisions/` | [CHANGELOG-kernel.md](./CHANGELOG-kernel.md) |
| `src/cli/` | `oms` commands, flags, and terminal output | `docs/install.md`, `docs/architecture.md` when command behavior or setup flow changes | [CHANGELOG-cli.md](./CHANGELOG-cli.md) |
| `src/mcp/` | MCP server, public tools, schemas, and host-facing behavior | `docs/adapters.md`, `docs/install.md`, `docs/architecture.md` | [CHANGELOG-mcp.md](./CHANGELOG-mcp.md) |
| `src/vendors/` | Optional third-party integrations and their boundary adapters | `docs/adapters.md`, relevant ADRs in `docs/decisions/` | [CHANGELOG-vendors.md](./CHANGELOG-vendors.md) |
| `src/assets/` | Packaged skills, host manifests, hooks, and static runtime assets | `docs/install.md`, `docs/adapters.md`, `docs/conventions.md` | [CHANGELOG-assets.md](./CHANGELOG-assets.md) |

### New command or flag checklist

- [ ] Update the affected documents in the CLI row above and its unreleased `CHANGELOG-cli.md` section.
- [ ] Add every new CLI command to the allowlist in `src/kernel/harness/surface-registry.ts`; otherwise the surface-set parity gate fails.
- [ ] Keep the three surfaces distinct: skills, MCP tools, and CLI commands are separate sets. MCP tools are a strict subset of skills that declare `mcp_tool`; the CLI allowlist is independent and may contain command-only entries.
- [ ] Run the relevant CLI help and the surface-parity test when changing a command or flag.

### New runtime backend checklist

- [ ] Implement `SearchBackend` from `src/kernel/searchbackend/` rather than bypassing the contract.
- [ ] Pass `src/kernel/searchbackend/conformance.test.ts` for the backend.
- [ ] Follow ADR-007: an unavailable backend must fail loudly with actionable guidance. Do not silently degrade to a fake or alternate backend.
- [ ] Update the kernel mapping documents and the unreleased `CHANGELOG-kernel.md` section.

### Load-bearing repository rules

- Every relative import under `src/` needs a `.js` extension. Only `tsc` catches a missing extension.
- `tsconfig.json` excludes `**/*.test.ts`; `npm run lint` does not typecheck tests. Run the focused Vitest test for test changes.
- Released changelog sections are immutable. Add entries only to the unreleased section.
- Pull-request CI runs changelog history, install, lint, build, test, and audit. Release verification runs on `oms-v*` tags in `.github/workflows/release.yml`, not per pull request.

### Documentation issue severity rubric

| Severity | Meaning | Merge policy |
| --- | --- | --- |
| Critical | Documentation names a command, flag, path, or behavior that is wrong and causes a user action to fail. | Block until fixed. |
| High | Documentation omits a required step or presents an unavailable capability as usable. | Block until fixed or a linked follow-up is accepted. |
| Medium | Terminology, structure, or optional behavior is unclear but users can complete the supported flow. | Non-blocking; fix before the next release. |
| Low | Cosmetic or alternative-usage gap with no incorrect outcome. | Non-blocking; address opportunistically. |

### Documentation decay detection

Run `npm run check:docs` to validate local Markdown links and conservative source-path references. When changing a surface, also use the mapping above: compare CLI help to its docs, confirm skill/tool/command registry parity, run backend conformance tests for backend changes, and keep generated host assets and manifests aligned. The checker catches broken references; it cannot infer changed behavior, so reviewers must apply the mapping table.
