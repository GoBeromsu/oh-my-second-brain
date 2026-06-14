# Oh My Second Brain Harness Architecture

Oh My Second Brain is an **axis graph harness** for an Obsidian markdown vault. Its purpose is not to generate note content for the user. Its purpose is to give host agents a deterministic contract for where knowledge belongs, which frontmatter axes describe it, how it links to other notes, and how it should be retrieved later.

The architecture is docs-first because the core product claim is semantic: capture is only good when it makes future retrieval and reuse easier.

## 1. Retrieval and reuse are the telos

Oh My Second Brain treats note making as a retrieval problem. A new note is successful when it can be found and reused later through the user's own knowledge axes.

That means capture and retrieval are separate flows over the same substrate:

- **Capture**: place the note under the right folder/concept, fill the frontmatter axes, preserve user body content, and validate contract conformity.
- **Retrieval**: narrow by folder/concept/frontmatter/wikilink axes first, optionally rank by search, then lazy-load the selected note bodies as payload.

Oh My Second Brain therefore optimizes for future reuse, not for the shortest possible write path.

## 2. User-owned ontology

The ontology is owned by the vault:

- `vault/.oms/taxonomy.yaml` declares folder intent and folder-to-concept bindings.
- `vault/.oms/concepts/*.yaml` declares concepts, frontmatter fields, and retrieval views.
- Markdown notes remain ordinary Obsidian notes.

Oh My Second Brain ships defaults, but setup copies them into the vault. After that, the live ontology is the user's editable contract. Oh My Second Brain must not impose a fixed taxonomy or silently overwrite user convention files.

## 3. Axes: frontmatter, folders, and wikilinks

Oh My Second Brain's intentional graph is built from user-authored structure:

| Primitive | Meaning |
|---|---|
| `property-axis` | A frontmatter key such as `author`, `status`, or `project`. |
| `property-value` | A frontmatter value that connects notes sharing the same axis value. |
| `folder-concept-edge` | A note's physical folder binding into the taxonomy/concept map. |
| `wikilink-edge` | An explicit user-authored relation in note body syntax such as `[[Target]]`. |
| `note` | The markdown file as a retrievable object. |

Folders are not merely storage. They are the most basic placement/classification edge in the ontology. Frontmatter fields add multiple retrieval dimensions on top of that physical placement. Wikilinks add explicit relational edges authored by the user.

## 4. Note duality: graph surface and body payload

A note has two operational layers:

1. **Graph surface**: path, folder, frontmatter, and wikilinks. This layer is used to validate the contract and build the intentional ontology graph.
2. **Body payload**: prose, excerpts, evidence, and free-form markdown. This layer is loaded lazily after axis/search narrowing.

Oh My Second Brain does not judge whether the body is true, complete, or high quality. Body content belongs to the user. Oh My Second Brain only checks whether the note conforms to the declared retrieval contract.

## 5. Capture flow

Capture is a write-side planning flow:

```text
content/intention
  → choose candidate folder/concept
  → infer required frontmatter axes from the concept contract
  → ask for missing required fields or route to inbox
  → validate contract conformity
  → write/append only through a safe, vault-confined path
```

Default failure posture:

- If placement is ambiguous, route to the configured inbox or ask a missing-field question.
- If required frontmatter is missing, ask for the missing axes before final commit when the write tool is active.
- If a note cannot safely be written inside the vault, refuse the write path.

## 6. Retrieve flow

Retrieval is a read-side narrowing flow:

```text
intent/query
  → resolve relevant concept/folder/property/wikilink axes
  → narrow candidates through the intentional graph
  → optionally fuse lexical/vector/hybrid search candidates
  → apply a retrieval view
  → lazy-load selected note bodies
```

This is the main difference from generic search. Search is useful, but it is not the first source of meaning. The user's ontology narrows intent first; search helps rank or fill gaps second.

## 7. Retrieval views, not "lens projection"

Existing concept files may contain `lenses`. Oh My Second Brain keeps this schema for compatibility, but user-facing docs should call them **retrieval views**.

A retrieval view is not the graph itself. It is an output shape applied after candidate notes have been selected by axis graph narrowing and optional search. For example, a `synthesis` retrieval view may choose to show `title`, `source-url`, and `author`, while an `audit` view may show `status` and `date-read`.

Order of operations:

1. Axis graph narrowing by folder/property/wikilink/concept.
2. Optional OMS semantic lexical/vector/hybrid search, either globally across the vault for broad semantic recall or restricted to the narrowed graph candidate space.
3. Retrieval view (`lenses` in YAML) selects the returned fields/excerpts.

Avoid the phrase "lens projection" unless a document defines it locally. Prefer "retrieval view" or "axis view".

## 8. Contract-conformity gates

Oh My Second Brain gates structural conformity, not content quality.

Contract checks include:

- required frontmatter fields
- declared field type/shape
- folder/concept binding
- enough axes to make later retrieval plausible
- ambiguous placement or missing required values

Default enforcement remains non-blocking warning behavior unless a future explicit strict mode is configured. A gate may ask for missing fields or route to inbox, but it must not rewrite user meaning or judge body truth.

## 9. Derived graph cache and search cache

Markdown notes and `.oms/` convention files are canonical. Everything under a cache/index layer is derived and rebuildable.

Recommended derived slices:

- graph schema cache
- note graph slices
- folder/concept edge index
- property-axis/value edge index
- wikilink edge index
- validation status
- lexical search index
- optional embedding/vector index

Invalidation rules:

| Change | Invalidates |
|---|---|
| `.oms/taxonomy.yaml` folder binding/intent | graph schema, folder-concept edges, retrieval route cache |
| `.oms/concepts/*.yaml` fields/views/intent | graph schema, property-axis nodes, retrieval view cache, validation plan |
| note path/folder move | that note's folder edge, graph membership, search collection metadata |
| note frontmatter key/value change | that note's property edges, validation result, graph slice |
| note body wikilink change | that note's wikilink edges and graph slice |
| note body text change without frontmatter/link change | search/embedding slice only |
| note deletion | graph slice, search entry, validation status |

Graph status should report stale slices separately: schema stale, graph stale, search stale, and embedding stale.

## 10. Claude Code skill/MCP installation surface

The first installable target is Claude Code. The harness surface should make Oh My Second Brain usable where the user is already working:

- skills for setup, doctor, capture, retrieve, and graph/status operations
- CLI commands for deterministic local actions
- MCP server for cross-host read/status tools first, then gated write tools

Current-vs-target boundary:

| Phase | Status | Scope |
|---|---|---|
| Phase 0 | docs/plan | This architecture and terminology lock. |
| Phase 1 | install shell | Claude Code skills, `oms setup`, and dry-run MCP registration guidance. |
| Phase 2 | runtime | Real stdio MCP read/status tools: `oms_graph_status`, `oms_list_concepts`, and `oms_validate_contract`. Write tools remain gated. |
| Phase 3 | derived cache | Ontology graph/search cache, invalidation slices, axis-first retrieval, and semantic lazy body access. |
| Phase 4 | safe writes | Capture prepare/commit tools after path-safety and vault-confinement tests. |

Docs must not describe MCP write/capture runtime as present tense until the server and tests exist.

The Phase 1 command surface is intentionally dry-run for Claude runtime registration:

```bash
oms setup --vault /path/to/vault --yes --install-claude
```

This initializes `.oms/` and prints a Claude Code plugin install command plus a `claude mcp add ...` command. It does not mutate Claude config. Capture/write tools are only available through the gated safe-write path.

Phase 3 adds a derived cache at `vault/.oms/cache/graph.json`. This file is not canonical. It can be rebuilt from markdown plus `.oms/` and contains:

- note graph slices for folder-concept, property-axis/value, and wikilink edges
- lexical search terms and body previews for search-second ranking
- source signatures for taxonomy, concept files, frontmatter, wikilinks, and body text
- staleness reasons that distinguish schema, graph, search, embedding, and validation slices

The MCP tools for this layer are:

- `oms_graph_build`
- `oms_retrieve_by_axis`
- `oms_lazy_load_note`

`oms_retrieve_by_axis` returns candidate notes and previews; `oms_lazy_load_note` reads full body payload only after a note has been selected.

Phase 4 adds safe capture tools:

- `oms_capture_prepare` plans placement, asks for missing required frontmatter fields, or routes ambiguous captures to inbox.
- `oms_capture_commit` creates or appends a markdown note only after vault-relative path checks and concept contract validation pass.

The write path rejects absolute paths, `..` escapes, non-markdown targets, `.oms/` internals, and frontmatter that violates the resolved concept contract.

## 11. External inspiration boundaries

Oh My Second Brain borrows patterns, not product identity:

- **OMS semantic retrieval**: anywhere access to a local markdown knowledge base through MCP/skills; lexical/vector search is a derived support layer.
- **Graphify**: graph effect as a useful retrieval affordance; Oh My Second Brain's graph is grounded in intentional frontmatter/folder/wikilink axes instead of inferred body concepts by default.
- **Ouroboros**: installable harness posture, stateful MCP/skill surfaces, and deterministic gates; Oh My Second Brain is not an OS-above host orchestrator.

The boundary matters: Oh My Second Brain is a user-owned ontology harness for Obsidian markdown folders, not a generic search engine, automatic graph extractor, or content generator.
