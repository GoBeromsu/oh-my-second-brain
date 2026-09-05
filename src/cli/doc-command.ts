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

export interface NoteDocumentGetOptions {
  readonly vault: string;
  readonly target?: string;
  readonly targets?: readonly string[];
  readonly notePath?: string;
  readonly collection?: string;
  readonly fromLine?: number;
  readonly lineCount?: number;
  readonly lineLimit?: number;
  readonly maxBytes?: number;
  readonly lineNumbers?: boolean;
  readonly fullPath?: boolean;
  readonly write: (message: string) => void;
}

/** Read-only document access shared by the note family and the retiring doc dispatcher. */
export async function getNoteDocuments(options: NoteDocumentGetOptions): Promise<number> {
  const selectors = [
    options.target === undefined ? 0 : 1,
    options.targets === undefined ? 0 : 1,
    options.notePath === undefined ? 0 : 1,
  ].reduce((sum, value) => sum + value, 0);
  if (selectors !== 1) throw new Error("NOTE_GET_ARGS_INVALID: choose exactly one of target, targets, or notePath");
  if (options.targets !== undefined && options.targets.length === 0) {
    throw new Error("NOTE_GET_ARGS_INVALID: targets must not be empty");
  }
  return runEngineSession(options.vault, { write: false }, async (adapter) => {
    const result = options.targets === undefined
      ? await adapter.getDocument({
        vault: options.vault,
        target: options.target ?? options.notePath!,
        collection: options.collection,
        fromLine: options.fromLine,
        lineCount: options.lineCount,
        lineNumbers: options.lineNumbers,
        fullPath: options.fullPath,
      })
      : await adapter.multiGetDocuments({
        vault: options.vault,
        targets: [...options.targets],
        collection: options.collection,
        lineLimit: options.lineLimit,
        maxBytes: options.maxBytes,
        lineNumbers: options.lineNumbers,
        fullPath: options.fullPath,
      });
    printJson(options.write, result);
    return result.available ? 0 : 1;
  });
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
    return getNoteDocuments({
      vault,
      target,
      collection: stringOption(args, "collection"),
      fromLine: numberOption(args, "fromLine"),
      lineCount: numberOption(args, "lineCount"),
      lineNumbers: booleanOption(args, "lineNumbers"),
      fullPath: booleanOption(args, "fullPath"),
      write,
    });
  }

  if (command === "multi-get") {
    const targets = targetList(rest);
    if (targets.length === 0) {
      writeError("Usage: oms doc multi-get <target...>");
      return 1;
    }
    return getNoteDocuments({
      vault,
      targets,
      collection: stringOption(args, "collection"),
      lineLimit: numberOption(args, "lineLimit"),
      maxBytes: numberOption(args, "maxBytes"),
      lineNumbers: booleanOption(args, "lineNumbers"),
      fullPath: booleanOption(args, "fullPath"),
      write,
    });
  }

  writeError(searchUsage());
  return 1;
}
