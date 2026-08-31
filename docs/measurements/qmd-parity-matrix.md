# qmd parity capability matrix

## Purpose and standing

This document pins the qmd baseline used by the frozen benchmark and accounts for the baseline's public capability surface. It is an inventory, not a relevance or quality assessment, and it makes no claim that OMS replaces qmd. A disposition records how the benchmark objective treats a capability; it does not assert equivalent results, interfaces, or deployment topology.

## Pinned baseline

The baseline is [`tobi/qmd`](https://github.com/tobi/qmd) at exact commit `facd35e01359e59d938bc9418e93fb9318addee3`. A detached checkout was verified with `git rev-parse HEAD`, which returned that full hash. The checked-out `package.json` declares version `2.8.3` (`package.json:2-3` @ pinned commit), so the declared version agrees with the approved v2.8.3 pin.

The globally selected qmd binary was checked directly on 2026-08-30 and reports
`qmd 2.1.0`; that binary is **not** admissible. On 2026-08-31 the exact comparator
was separately installed without replacing the global command at
`~/.cache/oms/parity/qmd-2.8.3-facd35e01359e59d938bc9418e93fb9318addee3`.
Its wrapper reports `qmd 2.8.3 (facd35e)`, `git rev-parse HEAD` reports the full
pinned commit, and package smoke passes under Node and Bun with every packaged AST
Official runs must set `OMS_QMD_ROOT` to that checkout so preflight can
verify both semver and full commit provenance; semver alone is insufficient.
They also provide one named-index config containing exactly the frozen vault
collection. The runner rejects ignore/update directives, verifies qmd global and
path context exactly match the active taxonomy-intent projection, runs qmd
`update` and `embed`, and requires status document count to equal the frozen
corpus with zero pending embeddings before any comparator query is scored.

## Capability matrix

The evidence column refers only to source at commit `facd35e01359e59d938bc9418e93fb9318addee3`. The four disposition values are closed: `existing`, `to-build`, `intentionally different`, and `out of scope`.

| qmd capability | evidence (file:line @ pinned commit) | OMS disposition | rationale |
|---|---|---|---|
| Public CLI topology includes `query`, `search`, `vsearch`, `get`, `multi-get`, MCP, benchmark, collection/context, status, update, embed, pull, and cleanup commands, with search controls for collection, candidate limit, reranking, output, paths, and scores. | `cli/qmd.ts:3572-3601`, `cli/qmd.ts:3612-3663` @ pinned commit | out of scope | This objective accounts for capabilities, but it does not clone qmd's command names, flags, aliases, or command topology. OMS exposes its own bounded CLI and adapter contracts. |
| Plain `query` is an expansion query: an unprefixed single line is passed to the local expansion model, which emits typed `lex`, `vec`, and `hyde` variants; the hybrid pipeline fuses candidates and reranks unless reranking is disabled. | `docs/SYNTAX.md:8-15`, `docs/SYNTAX.md:29-36`, `docs/SYNTAX.md:93-103`; `store.ts:5430-5441` @ pinned commit | intentionally different | The `SearchBackend` contract keeps a plain OMS query lexical-only. Semantic expansion is never an implicit side effect of an untyped query. |
| Lexical search is available directly through `search` and through typed `lex:` queries. Lex syntax supports prefix terms, exact phrases, and term or phrase negation. | `cli/qmd.ts:3573-3577`; `docs/SYNTAX.md:39-61` @ pinned commit | existing | OMS has lexical retrieval as the model-independent path and as an explicit typed sub-query. |
| Vector similarity search is available through `vsearch` and typed `vec:` queries; vector text is natural language without the lexical grammar. | `cli/qmd.ts:3576-3578`; `docs/SYNTAX.md:63-70`; `cli/qmd.ts:4691-4702` @ pinned commit | existing | OMS has an explicit vector sub-query and dedicated vector-search path. Model unavailability is surfaced instead of approximated. The measured sqlite-vec k-NN clamp of 4096 remains a measured constraint in this objective. |
| HyDE is a typed vector-routed query whose text is a hypothetical answer passage. It can participate in a multi-line query document alongside lexical and vector queries. | `docs/SYNTAX.md:22-27`, `docs/SYNTAX.md:72-90`; `store.ts:5435-5439` @ pinned commit | existing | OMS accepts an explicit `hyde` sub-query and routes it through the embedding capability. |
| Reranking is part of qmd's hybrid and structured pipelines by default. MCP `query.rerank` defaults to `true`, while CLI callers can opt out with `--no-rerank`. | `mcp/server.ts:338-358`, `mcp/server.ts:379-396`; `cli/qmd.ts:3632-3633`; `store.ts:5669-5676` @ pinned commit | intentionally different | ADR-011 makes OMS reranking explicit opt-in and default-false. ADR-007 requires a requested but unavailable model capability to fail loudly rather than silently return an unrereanked substitute. |
| Query expansion uses a generation model. qmd defines built-in embedding, reranking, and generation GGUF URIs, and resolves each from config, then environment, then its built-in default. | `llm.ts:281-312`, `llm.ts:1601-1668` @ pinned commit | existing | OMS exposes the closed, explicit `{ kind: "expand", profile: "qmd-v2.8.3" }` strategy. The generated `lex`/`vec`/`hyde` plan is validated and recorded before native dispatch; unavailable generation fails loudly. This deliberately does not make plain query implicit expansion. |
| Collection and folder context is human-authored. qmd supports a global context plus path-prefix contexts, and result context accumulates the global value and every matching prefix from general to specific. | `example-index.yml:12-15`, `example-index.yml:38-49`; `store.ts:3437-3470` @ pinned commit | intentionally different | OMS projects folder context solely from active `.oms/taxonomy.yaml` `intent`, the single source of truth, into expansion and reranking. Query receipts, status, and context listing expose source provenance and unmatched-folder warnings; OMS does not add a second arbitrary path-context hierarchy. |
| Collection management covers list, add, remove, rename, show, include/exclude-from-default-search, and pre-update command configuration. Collections carry paths, glob patterns, ignores, context, and default-inclusion state. | `cli/qmd.ts:4443-4602`; `example-index.yml:31-38`, `example-index.yml:63-87` @ pinned commit | intentionally different | OMS operates on one verified vault and does not reproduce qmd's global collection registry. Vault resolution and scope remain OMS contracts rather than a parallel collection topology. |
| A collection may define an `update` shell command; `qmd update` runs it with `bash -c` in the collection directory before reindexing and aborts on a non-zero exit. | `example-index.yml:52-59`; `cli/qmd.ts:928-985` @ pinned commit | intentionally different | OMS does not execute collection-defined shell commands. Index maintenance reads the verified vault without turning vault configuration into an executable hook surface. |
| `index.yml` is qmd's collection/configuration source of truth. Its schema includes `global_context`, editor URI, `models.embed`, `models.rerank`, `models.generate`, and named collection records. | `example-index.yml:1-10`, `example-index.yml:12-29`; `collections.ts:18-45` @ pinned commit | intentionally different | OMS does not adopt qmd's `index.yml` schema. Vault taxonomy remains separate from host-local, capability-specific model identity and verified installation evidence. |
| qmd can acquire models explicitly with `pull`, and model resolution for an `hf:` URI downloads into its model cache when needed; `embed` and `query` can therefore trigger model resolution without a prior pull. | `cli/qmd.ts:4660-4679`; `llm.ts:495-540`, `llm.ts:1093-1104` @ pinned commit | intentionally different | ADR-007 and ADR-012 prohibit OMS runtime model downloads and fabricated or silent fallbacks. Models are installed and verified through explicit setup; unavailable capabilities report their configuration remedy. |
| MCP exposes the tools `query`, `get`, `multi_get`, and `status`; the query tool accepts either one plain query or typed searches, not both. | `mcp/server.ts:239-358`, `mcp/server.ts:364-396`, `mcp/server.ts:403-532`, `mcp/server.ts:535-566` @ pinned commit | existing | OMS exposes canonical MCP retrieval, document, and status capabilities. Its tool names and plain-query semantics remain OMS contracts rather than qmd API compatibility promises. |
| MCP exposes documents as read-only `qmd://{path}` resources. | `mcp/server.ts:204-237` @ pinned commit | intentionally different | ADR-010 retired the qmd-named aliases and `qmd://` resource as OMS compatibility obligations. OMS keeps vault-relative real paths and its own resource surface. |
| Single-document retrieval accepts a path or docid and optional line ranges. Multi-get accepts a glob, comma-separated names, or docids and supports per-document line and byte limits. | `cli/qmd.ts:4411-4438`; `mcp/server.ts:403-474`, `mcp/server.ts:476-532` @ pinned commit | existing | OMS provides document get and multi-get over vault-relative real-path identity, including bounded body retrieval. |
| Index maintenance separates reindexing (`update`), vector generation/refresh (`embed`), and cleanup. Cleanup can preview or remove caches, orphaned vectors/content, and inactive documents, then compact FTS and vacuum the database. | `cli/qmd.ts:4627-4658`, `cli/qmd.ts:4906-4935`; `maintenance.ts:20-70` @ pinned commit | existing | OMS provides sync/update/embed and cleanup operations over its derived index. Model lineage and availability remain explicit OMS constraints. |
| `bench` accepts a fixture file, optional JSON output, and collection scope, then invokes qmd's benchmark runner against the active database/configuration. | `cli/qmd.ts:4715-4731` @ pinned commit | out of scope | The frozen comparator uses OMS's preregistered measurement protocol. Reproducing qmd's product `bench` command or fixture API is not required by this objective. |
| Global and hierarchical context are also surfaced through context management: `/` denotes global context, while collection/path entries are added, listed, checked, or removed. | `cli/qmd.ts:4334-4404`; `cli/qmd.ts:619-690`; `example-index.yml:12-15`, `example-index.yml:41-49` @ pinned commit | intentionally different | OMS uses one taxonomy `intent` source for folder context and does not maintain qmd-style global plus arbitrary hierarchical context records. Query-level `intent` remains a separate request input. |

No qmd capability in this matrix is marked unverified; each row was checked against the pinned checkout. That statement is limited to the inventoried surface above and does not extend to behavior not represented by a row.

## What “full parity” means here

“Full parity” is bounded disposition completeness: every inventoried qmd row is classified as `existing`, `to-build`, `intentionally different`, or `out of scope`, with the deliberate differences and scope boundaries stated. It is not an unbounded promise to clone qmd's API, command layout, configuration topology, process model, or defaults. A benchmark result must therefore be interpreted against this matrix rather than treating unlike product contracts as missing implementations.

## Blocking preconditions for the comparator arm

The exact qmd v2.8.3 comparator is installed at the stable cache path above. The
global `qmd 2.1.0` still cannot stand in for it; use `OMS_QMD_ROOT` so executable
preflight verifies the exact checkout rather than whichever binary appears first
on `PATH`.

The vault owner must also author the frozen query set and curated qrels before the comparator arm runs. Relevance labels are human input; an agent must never fabricate them or infer them from either system's returned ordering.

The preregistration must also identify the exact corpus by both digest and file
count. Preflight compares the live snapshot to both fields before any embed or
query work. The approved historical count is 20,959 files; the currently live
vault has 21,067 files and changing content digests, so it cannot be substituted
without the owner providing the historical snapshot or explicitly authorizing a
new preregistration.

## Change control

Changing the pinned commit changes the comparator definition. Any such change invalidates prior runs for this baseline and requires a new preregistration before measurement resumes.
