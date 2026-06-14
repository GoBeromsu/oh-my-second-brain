export function semanticUsageText(): string {
  return `OMS semantic search:
  oms semantic sync|update|embed [--collection <name>] [--index <path>] [--storage qmd-sqlite|oms-native-json] [--model-path <gguf>]
  oms semantic status [--index <path>] [--storage qmd-sqlite|oms-native-json]
  oms semantic query <text> [--lex <text>] [--vec <text>] [--hyde <text>] [-n <limit>]
  oms semantic search <text> [-n <limit>]
  oms semantic vsearch <text> [-n <limit>]
  oms semantic get <target> [--from-line <n>] [--line-count <n>]
  oms semantic multi-get <target...> [--line-limit <n>] [--max-bytes <n>]
  oms semantic collection add [path] --name <collection> [--pattern <glob>]
  oms semantic collection list|show|remove|rename|update-cmd|include|exclude
  oms semantic context add|list|rm [collection[/path]] [text]
  oms semantic ls [collection[/path]]
  oms semantic init|cleanup|doctor|pull|bench
  oms semantic serve [--host 127.0.0.1] [--port 8765]

Compatibility aliases: oms query|search|vsearch|get|multi-get|status|embed|collection|context|ls`;
}
