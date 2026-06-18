export function semanticUsageText(): string {
  return `OMS semantic search (native engine):
  oms semantic sync|update|embed [--collection <name>] [--index <path>] [--no-embed] [--force]
  oms semantic status [--index <path>]
  oms semantic query <text> [--lex <text>] [--vec <text>] [--hyde <text>] [-n <limit>]
  oms semantic search <text> [-n <limit>]
  oms semantic vsearch <text> [-n <limit>]
  oms semantic get <target> [--from-line <n>] [--line-count <n>]
  oms semantic multi-get <target...> [--line-limit <n>] [--max-bytes <n>]
  oms semantic collection list|show [name]
  oms semantic context list
  oms semantic cleanup
  oms semantic serve [--host 127.0.0.1] [--port 8765]

Embeddings are explicit: set OMS_EMBEDDING_PROVIDER (gguf|upstage) and OMS_EMBEDDING_MODEL.
Without them, lexical search and document reads work; vector/HyDE fail fast.

Compatibility aliases: oms query|search|vsearch|get|multi-get|status|embed|collection|context|cleanup`;
}
