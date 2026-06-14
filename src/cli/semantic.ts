import path from "node:path";
import {
  cleanupSemanticStore,
  getSemanticDocument,
  initSemanticStore,
  listSemanticDocuments,
  multiGetSemanticDocuments,
  pullSemanticModels,
  querySemanticStore,
  readSemanticDoctor,
  readSemanticStatus,
  runSemanticBenchmark,
  syncSemanticEmbeddingStore,
} from "../search/semantic.js";
import {
  booleanOption,
  numberOption,
  parseSemanticArgs,
  printJson,
  semanticQueryOptions,
  semanticStorageOption,
  stringListOption,
  stringOption,
  targetList,
} from "./semantic-args.js";
import { startSemanticHttpServer } from "./semantic-http.js";
import { runCollectionCommand, runContextCommand } from "./semantic-metadata-commands.js";
import { semanticUsageText } from "./semantic-usage.js";

export interface SemanticCliRunOptions {
  readonly argv: readonly string[];
  readonly vault: string;
  readonly write?: (message: string) => void;
  readonly writeError?: (message: string) => void;
}

const TOP_LEVEL_COMMANDS = new Set([
  "semantic",
  "query",
  "search",
  "vsearch",
  "get",
  "multi-get",
  "status",
  "embed",
  "collection",
  "context",
  "ls",
  "init",
  "cleanup",
  "doctor",
  "pull",
  "bench",
  "serve",
  "http",
]);

export function isSemanticCliCommand(command: string | undefined): boolean {
  return command !== undefined && TOP_LEVEL_COMMANDS.has(command);
}

export { semanticUsageText } from "./semantic-usage.js";

export async function runSemanticCli(options: SemanticCliRunOptions): Promise<number> {
  const write = options.write ?? ((message: string) => console.log(message));
  const writeError = options.writeError ?? ((message: string) => console.error(message));
  const parsed = parseSemanticArgs(options.argv);
  const command = parsed.positional[0] === "semantic" ? parsed.positional[1] : parsed.positional[0];
  const commandOffset = parsed.positional[0] === "semantic" ? 2 : 1;
  const rest = parsed.positional.slice(commandOffset);

  if (!command || command === "help") {
    write(semanticUsageText());
    return 0;
  }

  if (command === "init") {
    const result = await initSemanticStore({
      vault: options.vault,
      index: stringOption(parsed, "index"),
      storage: semanticStorageOption(parsed),
    });
    printJson(write, result);
    return result.available ? 0 : 1;
  }

  if (command === "sync" || command === "update" || command === "embed") {
    const result = await syncSemanticEmbeddingStore({
      vault: options.vault,
      collection: stringOption(parsed, "collection"),
      pattern: stringOption(parsed, "pattern"),
      ignore: stringListOption(parsed, "ignore"),
      includeByDefault: booleanOption(parsed, "includeDefault"),
      updateCommand: stringOption(parsed, "updateCommand"),
      index: stringOption(parsed, "index"),
      storage: semanticStorageOption(parsed),
      modelPath: stringOption(parsed, "modelPath"),
      force: booleanOption(parsed, "force"),
      pull: booleanOption(parsed, "pull"),
      update: booleanOption(parsed, "update"),
      embed: booleanOption(parsed, "embed"),
      chunkStrategy: stringOption(parsed, "chunkStrategy"),
      maxDocsPerBatch: numberOption(parsed, "maxDocsPerBatch"),
      maxBatchMb: numberOption(parsed, "maxBatchMb"),
    });
    printJson(write, result);
    return result.available ? 0 : 1;
  }

  if (command === "status") {
    const status = await readSemanticStatus({
      vault: options.vault,
      index: stringOption(parsed, "index"),
      storage: semanticStorageOption(parsed),
      modelPath: stringOption(parsed, "modelPath"),
    });
    printJson(write, status);
    return status.available ? 0 : 1;
  }

  if (command === "doctor") {
    const result = await readSemanticDoctor({
      vault: options.vault,
      index: stringOption(parsed, "index"),
      storage: semanticStorageOption(parsed),
      modelPath: stringOption(parsed, "modelPath"),
    });
    printJson(write, result);
    return result.available ? 0 : 1;
  }

  if (command === "cleanup") {
    const result = await cleanupSemanticStore({
      vault: options.vault,
      index: stringOption(parsed, "index"),
      storage: semanticStorageOption(parsed),
    });
    printJson(write, result);
    return result.available ? 0 : 1;
  }

  if (command === "pull") {
    printJson(write, pullSemanticModels());
    return 0;
  }

  if (command === "bench") {
    return runBenchCommand(rest, parsed, options.vault, write, writeError);
  }

  if (command === "ls") {
    const result = await listSemanticDocuments({
      vault: options.vault,
      index: stringOption(parsed, "index"),
      storage: semanticStorageOption(parsed),
      target: rest[0],
    });
    printJson(write, result);
    return result.available ? 0 : 1;
  }

  if (command === "query" || command === "search" || command === "vsearch") {
    const mode = command === "search" ? "search" : command === "vsearch" ? "vsearch" : "query";
    const result = await querySemanticStore(semanticQueryOptions(mode, options.vault, parsed, rest.join(" ")));
    printJson(write, result);
    return result.available ? 0 : 1;
  }

  if (command === "get") return runGetCommand(rest, parsed, options.vault, write, writeError);
  if (command === "multi-get") return runMultiGetCommand(rest, parsed, options.vault, write, writeError);
  if (command === "collection") return runCollectionCommand(rest[0], rest[1], parsed, options.vault, write, writeError);
  if (command === "context") return runContextCommand(rest[0], rest, parsed, options.vault, write, writeError);

  if (command === "serve" || command === "http") {
    const server = await startSemanticHttpServer({
      vault: options.vault,
      host: stringOption(parsed, "host"),
      port: numberOption(parsed, "port") ?? 8765,
      index: stringOption(parsed, "index"),
      storage: semanticStorageOption(parsed),
      modelPath: stringOption(parsed, "modelPath"),
    });
    printJson(write, { available: true, url: server.url });
    await new Promise(() => undefined);
    return 0;
  }

  writeError(semanticUsageText());
  return 1;
}

async function runBenchCommand(
  rest: readonly string[],
  parsed: ReturnType<typeof parseSemanticArgs>,
  vault: string,
  write: (message: string) => void,
  writeError: (message: string) => void,
): Promise<number> {
  const fixture = rest[0];
  if (!fixture) {
    writeError("Usage: oms semantic bench <fixture.json>");
    return 1;
  }
  const result = await runSemanticBenchmark({
    vault,
    index: stringOption(parsed, "index"),
    storage: semanticStorageOption(parsed),
    modelPath: stringOption(parsed, "modelPath"),
    fixture: path.resolve(vault, fixture),
    collection: stringOption(parsed, "collection"),
  });
  printJson(write, result);
  return result.available && result.failed === 0 ? 0 : 1;
}

async function runGetCommand(
  rest: readonly string[],
  parsed: ReturnType<typeof parseSemanticArgs>,
  vault: string,
  write: (message: string) => void,
  writeError: (message: string) => void,
): Promise<number> {
  const target = rest[0];
  if (!target) {
    writeError("Usage: oms semantic get <target>");
    return 1;
  }
  const result = await getSemanticDocument({
    vault,
    target,
    collection: stringOption(parsed, "collection"),
    index: stringOption(parsed, "index"),
    storage: semanticStorageOption(parsed),
    modelPath: stringOption(parsed, "modelPath"),
    fromLine: numberOption(parsed, "fromLine"),
    lineCount: numberOption(parsed, "lineCount"),
    lineNumbers: booleanOption(parsed, "lineNumbers"),
    fullPath: booleanOption(parsed, "fullPath"),
  });
  printJson(write, result);
  return result.available ? 0 : 1;
}

async function runMultiGetCommand(
  rest: readonly string[],
  parsed: ReturnType<typeof parseSemanticArgs>,
  vault: string,
  write: (message: string) => void,
  writeError: (message: string) => void,
): Promise<number> {
  const targets = targetList(rest);
  if (targets.length === 0) {
    writeError("Usage: oms semantic multi-get <target...>");
    return 1;
  }
  const result = await multiGetSemanticDocuments({
    vault,
    targets,
    collection: stringOption(parsed, "collection"),
    index: stringOption(parsed, "index"),
    storage: semanticStorageOption(parsed),
    modelPath: stringOption(parsed, "modelPath"),
    lineLimit: numberOption(parsed, "lineLimit"),
    maxBytes: numberOption(parsed, "maxBytes"),
    lineNumbers: booleanOption(parsed, "lineNumbers"),
    fullPath: booleanOption(parsed, "fullPath"),
  });
  printJson(write, result);
  return result.available ? 0 : 1;
}
