export function searchUsage(): string {
  return `OMS search:
  oms search <text> [--mode query|search|vsearch] [--lex <text>] [--vec <text>] [--hyde <text>] [--expand] [--max-queries <1..32>] [--rerank|--no-rerank] [-n <limit>]
  oms search --path <vault-relative path> [--vault <path>]
  oms search --context [--template <id>] [--folder <path>] [--property <name> --value <value>] [--wikilink <target>] [--query <text>]
  oms search --link <note> [--folder <name>] [--json] [--vault <path>]

The index is built and inspected under doctor:
  oms doctor sync-embeddings --mode sync|embed|repair [--collection <name>] [--index <path>] [--repair-mode rebuild|drop] [--dry-run]
  oms doctor cleanup [--index <path>]
  oms doctor status

A leading --link suggests wikilinks for one note; --link after query text filters results.
Use \`oms search -- <text>\` when the text itself starts with a flag or is the word query.

--path reads one note exactly, without opening the index or loading a model. It matches the
path NFC-insensitively, refuses .. and paths that escape the vault, prints the on-disk path and a
sha256 revision, and cannot be combined with a subcommand, query text, or mode flags.

A plain search is lexical-only. --lex, --vec, and --hyde select explicit typed channels.
--expand selects only {kind:'expand',profile:'qmd-v2.8.3',maxQueries?}; --max-queries must be
an integer from 1 through 32. Reranking is opt-in with --rerank; --no-rerank explicitly disables it.

Vector search needs the embed capability: OMS_EMBEDDING_PROVIDER and OMS_EMBEDDING_MODEL.
HyDE needs both the generate pair (OMS_GENERATE_PROVIDER and OMS_GENERATE_MODEL) and the embed
pair. Reranking needs OMS_RERANK_PROVIDER and OMS_RERANK_MODEL. Configure installed models with
oms setup model install --default or oms setup model install --descriptor <path>, then oms setup model select;
incomplete or unavailable capability pairs fail loudly rather than falling back.`;
}
