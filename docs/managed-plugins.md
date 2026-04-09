# Managed Plugins

OMSB can help manage selected Obsidian plugins.

## What OMSB may do

- register managed plugins during `/omsb init`
- read plugin-owned `data.json`
- apply guideline-explicit setting changes
- propose optimization-only changes for approval

## What OMSB must not do

- edit plugin source code
- edit plugin CSS
- edit plugin JS bundles
- create a second persistent shadow store of plugin settings

## Guideline + upstream docs

OMSB may consult upstream/GitHub docs to understand supported settings, but:

- upstream docs do **not** outrank the vault guideline
- approval rules still apply for optimization-only changes
