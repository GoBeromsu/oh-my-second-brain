# Demo Guide

Use a **sanitized demo vault only** when recording OMSB screenshots or GIFs.

## Hard privacy rule

Never capture:
- real note titles
- real folder names that reveal personal/work context
- usernames in filesystem paths
- email addresses
- plugin data containing personal values
- secrets, tokens, or API keys
- private vault structure

If any of the above appears on screen, do **not** ship the screenshot or GIF.

## Recommended demo vault setup

Use a throwaway vault such as:

- `DemoVault`
- `90. Guidelines/`
- `10. Sources/`
- `20. Terminology/`
- `Inbox/`

Example guideline files:
- `Folder Guideline.md`
- `Frontmatter Guideline.md`

## Recommended asset names

- `docs/assets/quick-start-init.png`
- `docs/assets/terminology-routing.gif`
- `docs/assets/plugin-settings.png`

## Capture checklist

Before publishing a screenshot or GIF, verify:
- vault name is generic
- no personal note content is visible
- no personal filesystem path is visible
- no account or machine name is visible
- plugin settings shown are safe demo values only
- terminal history does not reveal private commands or paths

## Suggested demo sequence

1. Open a demo vault
2. Run `/omsb init`
3. Show guideline folder selection
4. Show terminology routing outcome (`explicit`, `Inbox`, or `proposal`)
5. Show managed plugin-settings inspection on safe demo data
