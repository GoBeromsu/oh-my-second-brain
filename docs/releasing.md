# Releasing OMSB

This document is the **canonical maintainer release workflow**.

## Scope

This is a version-agnostic guide for releasing `v<version>`.
It reflects the current OMSB release model:
- build and test in CI
- manual version bump
- manual GitHub push
- manual GitHub release creation

## Release checklist

1. Update versions in:
   - `package.json`
   - `.claude-plugin/plugin.json`
2. Verify locally:

```bash
npm run build
npm test
```

3. Commit changes with a Lore-format commit message
4. Push the branch to GitHub
5. Create the release tag:

```bash
gh release create v<version> --target <commit-sha> --title "v<version>"
```

6. Verify:
   - the release page exists
   - README badges still resolve
   - release notes match the shipped behavior

## Notes

- This workflow is manual even though CI is automated.
- Keep README as the public front door; keep the full release checklist here.
