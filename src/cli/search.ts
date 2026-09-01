import { runDocCommand } from "./doc-command.js";
import { runIndexCommand } from "./index-command.js";
import {
  booleanOption,
  parseSearchArgs,
  printJson,
  searchQueryOptions,
  stringOption,
} from "./search-args.js";
import { runEngineSession } from "./engine-session.js";
import { runServeHttp } from "./serve-http.js";
import { searchUsage } from "./search-usage.js";

export interface SearchCliRunOptions {
  readonly argv: readonly string[];
  readonly vault: string;
  readonly write?: (message: string) => void;
  readonly writeError?: (message: string) => void;
}

export const TOP_LEVEL_COMMANDS = new Set(["search", "index", "doc", "embed", "serve"]);

export function isSearchCliCommand(command: string | undefined): boolean {
  return command !== undefined && TOP_LEVEL_COMMANDS.has(command);
}

export { searchUsage } from "./search-usage.js";

export async function runSearchCli(options: SearchCliRunOptions): Promise<number> {
  const write = options.write ?? ((message: string) => console.log(message));
  const writeError = options.writeError ?? ((message: string) => console.error(message));
  const args = parseSearchArgs(options.argv);
  const command = args.positional[0];

  if (!command || command === "help") {
    write(searchUsage());
    return 0;
  }

  if (command === "search") {
    const query = args.positional.slice(1).join(" ")
      || stringOption(args, "lex")
      || stringOption(args, "vec")
      || stringOption(args, "hyde")
      || "";
    if (!query) {
      writeError("Usage: oms search <text>");
      return 1;
    }
    return runEngineSession(options.vault, { write: false }, async (adapter) => {
      const result = await adapter.semanticQuery(searchQueryOptions("query", options.vault, args, query));
      printJson(write, result);
      return result.available ? 0 : 1;
    });
  }

  if (command === "embed") {
    return runEngineSession(options.vault, { write: true, embed: true }, async (adapter) => {
      const result = await adapter.syncEmbeddings({
        vault: options.vault,
        collection: stringOption(args, "collection"),
        index: stringOption(args, "index"),
        embed: true,
        force: booleanOption(args, "force"),
        chunkStrategy: stringOption(args, "chunkStrategy"),
      });
      printJson(write, result);
      return result.available ? 0 : 1;
    });
  }

  if (command === "index") {
    return runIndexCommand({ args, vault: options.vault, write, writeError });
  }

  if (command === "doc") {
    return runDocCommand({ args, vault: options.vault, write, writeError });
  }

  if (command === "serve") {
    const server = await runServeHttp({
      vault: options.vault,
      host: stringOption(args, "host"),
      port: Number(stringOption(args, "port") ?? 8765),
      index: stringOption(args, "index"),
    });
    printJson(write, { available: true, url: server.url });
    await new Promise(() => undefined);
    return 0;
  }

  writeError(searchUsage());
  return 1;
}
