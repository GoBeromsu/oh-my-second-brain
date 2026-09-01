import {
  booleanOption,
  numberOption,
  printJson,
  stringOption,
  targetList,
  type ParsedSearchArgs,
} from "./search-args.js";
import { runEngineSession } from "./engine-session.js";
import { searchUsage } from "./search-usage.js";

export interface DocCommandOptions {
  readonly args: ParsedSearchArgs;
  readonly vault: string;
  readonly write: (message: string) => void;
  readonly writeError: (message: string) => void;
}

export async function runDocCommand(options: DocCommandOptions): Promise<number> {
  const { args, vault, write, writeError } = options;
  const command = args.positional[1];
  const rest = args.positional.slice(2);

  if (command === "get") {
    const target = rest[0];
    if (!target) {
      writeError("Usage: oms doc get <target>");
      return 1;
    }
    return runEngineSession(vault, { write: false }, async (adapter) => {
      const result = await adapter.getDocument({
        vault,
        target,
        collection: stringOption(args, "collection"),
        fromLine: numberOption(args, "fromLine"),
        lineCount: numberOption(args, "lineCount"),
        lineNumbers: booleanOption(args, "lineNumbers"),
        fullPath: booleanOption(args, "fullPath"),
      });
      printJson(write, result);
      return result.available ? 0 : 1;
    });
  }

  if (command === "multi-get") {
    const targets = targetList(rest);
    if (targets.length === 0) {
      writeError("Usage: oms doc multi-get <target...>");
      return 1;
    }
    return runEngineSession(vault, { write: false }, async (adapter) => {
      const result = await adapter.multiGetDocuments({
        vault,
        targets: [...targets],
        collection: stringOption(args, "collection"),
        lineLimit: numberOption(args, "lineLimit"),
        maxBytes: numberOption(args, "maxBytes"),
        lineNumbers: booleanOption(args, "lineNumbers"),
        fullPath: booleanOption(args, "fullPath"),
      });
      printJson(write, result);
      return result.available ? 0 : 1;
    });
  }

  writeError(searchUsage());
  return 1;
}
