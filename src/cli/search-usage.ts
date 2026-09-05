export function searchUsage(): string {
  return `OMS search and index:
  oms search query <text> [--lex <text>] [--vec <text>] [--hyde <text>] [--expand] [--max-queries <1..32>] [--rerank|--no-rerank] [-n <limit>]
  oms search context [--template <id>] [--folder <path>] [--property <name> --value <value>] [--wikilink <target>] [--query <text>]
  oms index sync [--collection <name>] [--index <path>]
  oms index embed [--collection <name>] [--index <path>]
  oms index status [--view status|collections|contexts] [--index <path>]
  oms index repair --mode rebuild|drop [--dry-run]
  oms index clean [--index <path>]

A plain search is lexical-only. --lex, --vec, and --hyde select explicit typed channels.
--expand selects only {kind:'expand',profile:'qmd-v2.8.3',maxQueries?}; --max-queries must be
an integer from 1 through 32. Reranking is opt-in with --rerank; --no-rerank explicitly disables it.

Vector search needs the embed capability: OMS_EMBEDDING_PROVIDER and OMS_EMBEDDING_MODEL.
HyDE needs both the generate pair (OMS_GENERATE_PROVIDER and OMS_GENERATE_MODEL) and the embed
pair. Reranking needs OMS_RERANK_PROVIDER and OMS_RERANK_MODEL. Configure installed models with
oms setup --models-default, oms setup --models-descriptor <path>, or oms setup --models-no-default;
incomplete or unavailable capability pairs fail loudly rather than falling back.`;
}
