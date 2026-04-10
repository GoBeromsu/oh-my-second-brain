# oh-my-second-brain

[![CI](https://github.com/GoBeromsu/oh-my-second-brain/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/GoBeromsu/oh-my-second-brain/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/GoBeromsu/oh-my-second-brain?display_name=tag)](https://github.com/GoBeromsu/oh-my-second-brain/releases/latest)

**Guide your Obsidian vault the way you intended.**  
OMSB is a Claude Code plugin that turns your vault guidelines into **vault-local, mechanically enforced behavior**.

Instead of hoping an AI agent remembers your folder rules, frontmatter rules, note destinations, and plugin-setting conventions, OMSB gives Claude Code a structured contract for how to work inside a specific knowledge-management vault.

```text
DISCOVER → MAP → ENFORCE → ROUTE → VERIFY
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│Guidelines│ → │Vault Init │ → │Rule Layer │ → │Note/Plugin│ → │Freshness │
│  Folder  │   │ /omsb init│   │.omsb/rules│   │ Operations│   │  Checks   │
└──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘
```

---

## What OMSB does

OMSB is built for one narrow job:

> **Manage an Obsidian second-brain vault according to the vault's own guidelines.**

That means:
- keeping **folder** and **frontmatter** conventions aligned with your vault rules
- detecting and fixing violations when the rule is explicit
- turning ambiguity into a **proposal**, not a silent mutation
- routing notes like terminology notes without hard-coded vault paths
- helping manage selected Obsidian plugin settings through plugin-owned `data.json`

What OMSB is **not**:
- a general-purpose OMC-style orchestration framework
- a global, always-on Claude Code behavior layer across every repo
- a system that edits plugin source, CSS, or JS

---

## Quick Start

### 1) Add the marketplace to Claude Code

In `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": [
    "GoBeromsu/oh-my-second-brain"
  ]
}
```

### 2) Install the plugin

Inside Claude Code:

```text
/install oh-my-second-brain
```

### 3) Move into the vault you want to manage

```bash
cd ~/Obsidian/MyKnowledgeVault
```

### 4) Initialize OMSB for that vault

```text
/omsb init
```

OMSB then helps you:
- choose the **guideline folder**
- confirm which files represent the **folder** and **frontmatter** guidelines
- define an `Inbox` fallback for ambiguous routing
- register managed Obsidian plugins
- generate vault-local config and rules

### 5) Use OMSB inside that vault only

Example commands:

```text
/omsb compile
/omsb terminology
/omsb plugin-settings
```

---

## Commands

| What you're doing | Command | What OMSB does |
|---|---|---|
| Initialize a vault | `/omsb init` | discovers guideline sources, maps folder/frontmatter guideline files, registers managed plugins, generates config + rules |
| Compile source notes | `/omsb compile` | processes configured source notes into structured output using the compile pipeline |
| Create or route terminology notes | `/omsb terminology` | resolves destination as `explicit`, `inbox`, or `propose` |
| Inspect or adjust managed plugin settings | `/omsb plugin-settings` | reads guideline-informed settings intent, compares against plugin `data.json`, and applies or proposes changes |

---

## Why this is vault-scoped, not global

OMSB is intentionally **repo/vault scoped**.

You may install the plugin once in Claude Code, but OMSB only becomes active for a vault when that vault has:

- a readable `omsb.config.json`
- a readable `.omsb/rules.json`
- a freshness-clean guideline snapshot

So marketplace install is broad, but enforcement is local.

---

## Source hierarchy

OMSB uses a strict hierarchy:

1. **Guideline folder**  
   Human-written source of truth.
2. **`omsb.config.json`**  
   Vault-scoped mapping, managed plugin registry, routing fallback, compile settings.
3. **`.omsb/rules.json`**  
   Mechanically generated operational rules and source snapshot.

In short:
- humans write intent in guideline docs
- OMSB stores vault-local mapping in config
- OMSB generates machine-readable rules from that intent

Generated files help enforcement. They do **not** outrank the guideline docs.

---

## How OMSB works

### 1) Three-tier enforcement

| Tier | Source | Purpose |
|---|---|---|
| Tier 1 | `omsb.config.json` | vault-local mapping and deterministic config |
| Tier 2 | guideline annotations (`<!-- omsb: ... -->`) | machine-readable rules embedded in guideline docs |
| Tier 3 | generated `.omsb/CLAUDE.md` | advisory context for the LLM |

### 2) Freshness checks

OMSB records a guideline source snapshot in `.omsb/rules.json` and can detect:
- file edits
- file additions
- file removals
- file renames
- missing/unreadable configured guideline folders

If the source snapshot is stale, OMSB does **not** keep silently enforcing old assumptions. It asks you to refresh via `/omsb init`.

### 3) Routing contract

Every note-routing decision resolves to one of exactly three outcomes:

- **`explicit`** — guideline says exactly where it goes
- **`inbox`** — no explicit destination, so use configured fallback
- **`propose`** — ambiguous or missing rule, so OMSB creates a proposal instead of guessing

### 4) Obsidian-native operational boundary

For **user-visible vault mutations** such as note creation, move, rename, or routing, OMSB prefers an Obsidian-native path (for example Obsidian CLI / plugin integration).

For **non-user-visible generated artifacts**, direct filesystem writes are still acceptable, including:
- `omsb.config.json`
- `.omsb/rules.json`
- generated docs / proposal artifacts
- compile outputs
- managed plugin `data.json`

### 5) Managed plugin settings

OMSB can help manage selected Obsidian plugins, but with a hard boundary:

✅ allowed:
- read plugin-owned `data.json`
- apply **guideline-explicit** setting changes
- propose optimization-only changes for approval
- consult upstream/GitHub docs to learn what settings exist

❌ not allowed:
- edit plugin source code
- edit plugin CSS
- edit plugin JS bundles
- create a shadow persistent settings authority outside the plugin's own data

---

## Screenshots and demo GIFs

If you add screenshots or demo GIFs, use a **sanitized demo vault only**.

**Never include personal information** in demo assets. That includes:
- real note titles
- real folder names
- usernames in paths
- email addresses
- private vault structure
- secrets or plugin data with personal values

Recommended asset names:
- `docs/assets/quick-start-init.png`
- `docs/assets/terminology-routing.gif`
- `docs/assets/plugin-settings.png`

Use these supporting docs when preparing demo assets:
- [docs/demo-guide.md](docs/demo-guide.md)
- [docs/shot-list.md](docs/shot-list.md)
- [docs/demo-vault-template/README.md](docs/demo-vault-template/README.md)

---

## Example config

`omsb.config.json`

```json
{
  "version": 1,
  "vault_path": "/path/to/vault",
  "vault_name": "My Vault",
  "guidelines": {
    "root": "90. Guidelines",
    "files": [
      "Folder Guideline.md",
      "Frontmatter Guideline.md"
    ],
    "required": ["folder", "frontmatter"],
    "domains": {
      "folder": "Folder Guideline.md",
      "frontmatter": "Frontmatter Guideline.md"
    }
  },
  "rules": {
    "raw_paths": ["80. References/**"],
    "frontmatter_required": ["title", "type", "date"],
    "frontmatter_values": {
      "type": { "enum": ["article", "video", "book", "terminology"] },
      "date": { "format": "date" }
    },
    "naming_conventions": {
      "20. Terminology/**": { "pattern": "^[a-zA-Z0-9 ()-]+$" }
    }
  },
  "enforcement": {
    "raw_boundary": "block",
    "frontmatter": "deny",
    "naming": "deny"
  },
  "routing": {
    "inbox_fallback": "Inbox",
    "note_targets": {
      "terminology": ["20. Terminology"]
    }
  },
  "managed_plugins": [
    {
      "id": "example-plugin",
      "data_json_path": ".obsidian/plugins/example-plugin/data.json"
    }
  ],
  "compile": {
    "sources": ["10. Sources"],
    "terminology_dir": "20. Terminology",
    "outputs": {
      "wiki": "30. Wiki"
    }
  },
  "authorship": {
    "enabled": true,
    "agent_name": "claude",
    "created_by_field": "created_by",
    "modified_by_field": "modified_by"
  }
}
```

---

## Common flows

### Refresh after guideline changes

If you update guideline docs:

```text
/omsb init
```

Use this whenever you:
- change folder rules
- change frontmatter rules
- add/remove guideline files
- move the guideline folder

### Route a new terminology note

```text
/omsb terminology
```

Expected behavior:
- explicit destination → route there
- no explicit target → send to `Inbox`
- ambiguous target → create proposal artifact and ask

### Review plugin settings

```text
/omsb plugin-settings
```

Expected behavior:
- if the guideline explicitly requires a setting, OMSB may apply it
- if it is merely an optimization or a new possibility, OMSB asks first
- OMSB only modifies plugin `data.json`, never the plugin code itself

---

## What happens when something is missing?

If OMSB can't find or read the configured guideline folder, it should:

1. explore likely candidates
2. propose them to you
3. ask for confirmation
4. create the folder if needed

It should **not** continue silently with stale enforcement assumptions.

---

## Project structure

```text
oh-my-second-brain/
├── skills/
│   ├── init/
│   ├── compile/
│   ├── terminology/
│   └── plugin-settings/
├── agents/
│   ├── guideline-scanner.md
│   └── compile-worker.md
├── docs/
│   ├── philosophy.md
│   ├── architecture.md
│   └── managed-plugins.md
├── scripts/
│   ├── guideline-enforcer.mjs
│   ├── session-init.mjs
│   └── authorship-marker.mjs
├── src/
│   ├── config/
│   ├── init/
│   ├── rules/
│   ├── routing/
│   ├── obsidian/
│   ├── proposals/
│   ├── terminology/
│   └── __tests__/
└── .claude-plugin/
```

---

## Documentation

- [docs/philosophy.md](docs/philosophy.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/managed-plugins.md](docs/managed-plugins.md)
- [docs/demo-guide.md](docs/demo-guide.md)
- [docs/shot-list.md](docs/shot-list.md)
- [docs/releasing.md](docs/releasing.md)
- [docs/demo-vault-template/README.md](docs/demo-vault-template/README.md)

---

## Development

```bash
npm run build
npm test
```

---

## Release / deployment

OMSB is distributed as a Claude Code marketplace plugin.

For the full maintainer workflow, see [docs/releasing.md](docs/releasing.md).

Current release:
- [Latest release](https://github.com/GoBeromsu/oh-my-second-brain/releases/latest)

---

## Why this README is opinionated

Like the best agent-skill repos, OMSB is not trying to be a generic “AI helper.”
It encodes a specific worldview:

- **the vault owns the rules**
- **generated artifacts must stay subordinate to those rules**
- **explicit rules can be enforced automatically**
- **ambiguous cases must become proposals**
- **user-visible vault behavior should feel like using Obsidian, not raw file surgery**

If that matches how you want to run a second-brain vault, OMSB is for you.

---

## License

MIT
