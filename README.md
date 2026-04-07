# oh-my-second-brain

AI harness for second brain knowledge management — structurally enforce your vault guidelines on AI behavior.

## Philosophy

> "사용자가 세운 규칙에 따라 AI가 구조적으로 강제된다"
> — User guidelines become structural enforcement on AI.

oh-my-second-brain (OMSB) is a Claude Code plugin that translates your Obsidian vault guidelines into hard enforcement. Instead of hoping AI follows your rules, OMSB makes violation structurally impossible.

## How It Works

### Three-Tier Enforcement

| Tier | Source | Enforcement | Example |
|------|--------|-------------|---------|
| **1. Config Rules** | `omsb.config.json` | Deterministic | Raw paths, frontmatter schema, naming patterns |
| **2. Annotations** | `<!-- omsb: ... -->` in guidelines | Deterministic | Rule markers extracted at init time |
| **3. CLAUDE.md** | Generated from guidelines | Advisory (LLM follows) | Full guideline text for soft compliance |

### Hook Architecture

- **PreToolUse** (`Write|Edit|Bash`): Blocks raw source modifications, enforces naming/frontmatter rules
- **PostToolUse** (`Write|Edit`): Auto-marks AI authorship on generated files
- **SessionStart**: Checks rule staleness, injects vault context

## Installation

OMSB is distributed as a Claude Code marketplace plugin.

### 1. Add the marketplace

In your Claude Code settings (`~/.claude/settings.json`):
```json
{
  "extraKnownMarketplaces": [
    "GoBeromsu/oh-my-second-brain"
  ]
}
```

### 2. Install the plugin

In Claude Code, run:
```
/install oh-my-second-brain
```

### 3. Initialize your vault

Navigate to your vault directory and run:
```
/omsb init
```

This will:
1. Scan your vault for guideline files
2. Detect raw source directories
3. Generate `omsb.config.json`
4. Compile rules to `.omsb/rules.json`
5. Generate `.omsb/CLAUDE.md` with guideline references

## Skills

### `/omsb init`
Interactive vault setup. Discovers guidelines, configures enforcement boundaries, generates config and CLAUDE.md.

### `/omsb compile`
Process raw source notes through the compile pipeline. Reads sources (status: todo), applies type-specific adapters, generates compiled output with authorship and wikilinks.

## Config Schema

`omsb.config.json` at your vault root:

```json
{
  "version": 1,
  "vault_path": "/path/to/vault",
  "vault_name": "My Vault",
  "guidelines": {
    "root": "Settings/Guidelines",
    "files": ["Core Guideline.md", "Frontmatter Guideline.md"]
  },
  "rules": {
    "raw_paths": ["References/**"],
    "frontmatter_required": ["title", "type", "date"],
    "frontmatter_values": {
      "type": { "enum": ["article", "video", "book"] },
      "date": { "format": "date" }
    },
    "naming_conventions": {
      "Terminologies/**": { "pattern": "^[가-힣a-zA-Z0-9 ()-]+$" }
    }
  },
  "enforcement": {
    "raw_boundary": "block",
    "frontmatter": "deny",
    "naming": "deny"
  },
  "authorship": {
    "enabled": true,
    "agent_name": "claude",
    "created_by_field": "created_by",
    "modified_by_field": "modified_by"
  }
}
```

## Tier 2 Annotations

Add machine-readable markers to your guideline files:

```markdown
## Raw Sources
<!-- omsb: rule-type="path-boundary" severity="block" paths="References/**" -->
Raw sources are read-only. AI must not modify source content.
```

## Development

```bash
# Build TypeScript
npm run build

# Run tests
npm test
```

## License

MIT
