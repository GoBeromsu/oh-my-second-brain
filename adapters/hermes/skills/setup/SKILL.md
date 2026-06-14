---
name: setup
description: Adopt an Obsidian markdown vault into the Oh My Second Brain convention and optionally install host MCP integration.
---

# oms-setup

Use when the user wants to initialize Oh My Second Brain for a vault.

Run:

```bash
oms setup --vault <vault>
```

For a non-interactive first pass:

```bash
oms setup --vault <vault> --yes
```

To interview each folder axis and merge observed note frontmatter into concept schemas:

```bash
oms setup --vault <vault> --suggest-fields
```

Then, when host registration is desired:

```bash
oms install --runtime codex --vault <vault> --yes
```

Setup interviews folder intent, concept binding, optional observed fields, and retrieval lenses. It rejects lenses that reference unknown fields. Do not modify vault notes during setup. Oh My Second Brain writes only `vault/.oms/taxonomy.yaml` and `vault/.oms/concepts/`, preserving existing concept files while adding missing defaults or selected observed fields.
