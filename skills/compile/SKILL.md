---
name: compile
level: 2
description: Compile raw vault sources into structured knowledge
---

<Purpose>
Process raw source notes (status: todo) through the OMSB compile pipeline. Reads sources from configured paths, applies type-specific adapters (video, article, etc.), generates compiled output with authorship marking and wikilink connections.
</Purpose>

<Steps>
1. Load omsb.config.json and validate compile settings
2. Build term cache from terminology directory
3. Find sources matching filter criteria (default: status: todo)
4. For each source:
   a. Detect type from frontmatter (video, article, book, paper)
   b. Apply type-specific adapter
   c. Link terminology wikilinks using term cache
   d. Write output to configured path with authorship
   e. Update source status to "compiled"
5. Update index (if configured)
6. Report: N sources compiled, M outputs generated
</Steps>

<Tool_Usage>
- Use explore agent to scan source files before compilation
- Use executor agents (sonnet) for individual file compilation
- Use Write tool for output files
- Run term cache build first, then parallel compilation
</Tool_Usage>
