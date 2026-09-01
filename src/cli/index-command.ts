import {
  booleanOption,
  numberOption,
  printJson,
  stringOption,
  type ParsedSearchArgs,
} from "./search-args.js";
import { runEngineSession } from "./engine-session.js";
import { searchUsage } from "./search-usage.js";

export interface IndexCommandOptions {
  readonly args: ParsedSearchArgs;
  readonly vault: string;
  readonly write: (message: string) => void;
  readonly writeError: (message: string) => void;
}

export async function runIndexCommand(options: IndexCommandOptions): Promise<number> {
  const { args, vault, write, writeError } = options;
  const command = args.positional[1];

  if (command === "sync") {
    return runEngineSession(vault, { write: true, embed: false }, async (adapter) => {
      const result = await adapter.syncEmbeddings({
        vault,
        collection: stringOption(args, "collection"),
        index: stringOption(args, "index"),
        embed: false,
        force: booleanOption(args, "force"),
        chunkStrategy: stringOption(args, "chunkStrategy"),
        maxDocsPerBatch: numberOption(args, "maxDocsPerBatch"),
        maxBatchMb: numberOption(args, "maxBatchMb"),
      });
      printJson(write, result);
      return result.available ? 0 : 1;
    });
  }

  if (command === "status") {
    return runEngineSession(vault, { write: false }, async (adapter) => {
      const result = await adapter.semanticStatus({ vault, index: stringOption(args, "index") });
      printJson(write, result);
      return result.available ? 0 : 1;
    });
  }

  if (command === "cleanup") {
    return runEngineSession(vault, { write: true }, async (adapter) => {
      const result = await adapter.cleanup({ vault, index: stringOption(args, "index") });
      printJson(write, result);
      return result.available ? 0 : 1;
    });
  }

  if (command === "collections") {
    return runEngineSession(vault, { write: false }, async (adapter) => {
      const result = adapter.listCollections({ vault, index: stringOption(args, "index") });
      if (!result.available) {
        printJson(write, result);
        return 1;
      }
      const name = args.positional[2];
      printJson(write, { collections: name ? result.collections.filter((collection) => collection.name === name) : result.collections });
      return 0;
    });
  }

  if (command === "contexts") {
    return runEngineSession(vault, { write: false }, async (adapter) => {
      const result = await adapter.listContexts({ vault, index: stringOption(args, "index") });
      printJson(write, result);
      return result.available ? 0 : 1;
    });
  }

  writeError(`[oms] Unknown index subcommand: ${command ?? "(none)"}`);
  writeError(searchUsage());
  return 1;
}
