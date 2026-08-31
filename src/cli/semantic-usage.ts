export function semanticUsageText(): string {
  return `OMS semantic search (native engine):
  oms semantic sync|update|embed [--collection <name>] [--index <path>] [--no-embed] [--force]
  oms semantic status [--index <path>]
  oms semantic query <text> [--lex <text>] [--vec <text>] [--hyde <text>] [--expand] [--rerank] [-n <limit>]
  oms semantic search <text> [-n <limit>]
  oms semantic vsearch <text> [-n <limit>]
  oms semantic get <target> [--from-line <n>] [--line-count <n>]
  oms semantic multi-get <target...> [--line-limit <n>] [--max-bytes <n>]
  oms semantic collection list|show [name]
  oms semantic context list
  oms semantic cleanup
  oms semantic serve [--host 127.0.0.1] [--port 8765]

Plain query/search is lexical-only and works without models. --vec and vsearch require an available
embed model. --hyde requires two capabilities: a generate model to write the hypothetical document
and an embed model to embed it; it never falls back to embedding the raw query. Every unavailable
capability names its own configuration remedy.

--expand selects the closed qmd-v2.8.3 expansion profile. It asks the configured generate model
for validated typed lex/vec/HyDE channels and records the generated plan plus any active
.oms/taxonomy.yaml folder intents in the query receipt. It is explicit and never changes a plain
query. --max-queries <1..32> bounds the generated plan.

Model capability precedence is request, complete environment pair, .oms/models.json, setup default,
then unavailable. The exact environment pairs are OMS_EMBEDDING_PROVIDER/OMS_EMBEDDING_MODEL,
OMS_RERANK_PROVIDER/OMS_RERANK_MODEL, and OMS_GENERATE_PROVIDER/OMS_GENERATE_MODEL. A half pair
or malformed higher-precedence source fails; it never falls back.

Reranking is opt-in (--rerank on CLI; rerank: true for API/MCP callers). Omitted or false does not
load a reranker; a true request lazily resolves the configured reranker or fails loudly with its
configuration remedy. Active taxonomy folder intents are appended to the model query and recorded
with .oms/taxonomy.yaml provenance.

Examples:
  oms semantic query "exact words"                 # lexical only
  oms semantic query "concept" --vec "concept"     # requires embed capability
  oms semantic vsearch "concept"                   # requires embed capability
  oms semantic query "concept" --hyde "concept"    # requires generate + embed capabilities
  oms semantic query "concept" --expand             # explicit typed expansion
  oms semantic query "concept" --expand --rerank    # expansion + opt-in reranking

Top-level semantic commands: oms search|embed|collection|context|cleanup|serve|http`;
}
