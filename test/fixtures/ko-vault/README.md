# ko-vault fixture

Synthetic Korean vault used by the product-contract e2e suite
(`test/e2e/product-contract.test.ts`) and the latency baseline
(`scripts/bench/latency-baseline.mjs`). Later realignment PRs reuse it for Korean
search and normalization work. Every note is invented; none of it is medical guidance.

What it exercises:

- 30 notes in `Projects/`, `Areas/`, `Resources/`, `지식/` (a Hangul folder), and `Daily/`.
- Frontmatter with `template`, `status` (Korean and English values), `tags`, and `aliases`.
- Wikilinks with aliases, heading targets, and one unresolved target (`[[미작성 노트]]`).
- Mixed Korean/English text and compound nouns such as `낙상판정기준`.
- Hangul filenames. Git stores every path NFC.

## NFD filename

`지식/낙상 위험 평가.md` is committed NFC but must be exercised as NFD. A committed NFD path
breaks macOS checkouts: with `core.precomposeunicode=true` (the macOS default) git reports the
file as untracked under its NFC spelling forever. Always copy the fixture with
`materializeKoVault(dest)` from `test/fixtures/ko-vault.mjs`, which renames that one note to its
NFD spelling in the copy and leaves every other name NFC. Never point a test at this directory
directly: OMS commands may create `.oms/` state inside a vault.

This README is itself a note in the vault and has no frontmatter.
