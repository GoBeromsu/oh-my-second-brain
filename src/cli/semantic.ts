
import type { McpEngineAdapter } from "../kernel/engine/mcp/facade.js";
import { assembleSemanticEngine } from "../kernel/semantic/semantic-engine.js";
import {
  booleanOption,
  numberOption,
  parseSemanticArgs,
  printJson,
  semanticQueryOptions,
  stringOption,
} from "./semantic-args.js";
import { startSemanticHttpServer } from "./semantic-http.js";
import { semanticUsageText } from "./semantic-usage.js";

export interface SemanticCliRunOptions {
  readonly argv: readonly string[];
  readonly vault: string;
  readonly write?: (message: string) => void;
  readonly writeError?: (message: string) => void;
}

const TOP_LEVEL_COMMANDS = new Set([
  "semantic",
  "search",
  "embed",
  "collection",
  "context",
  "cleanup",
  "serve",
  "http",
]);

export function isSemanticCliCommand(command: string | undefined): boolean {
  return command !== undefined && TOP_LEVEL_COMMANDS.has(command);
}

export { semanticUsageText } from "./semantic-usage.js";

/** Assemble the engine adapter (vec-capable when configured, else lex + docs), run, dispose. */
async function withSemanticAdapter<T>(vault: string, fn: (adapter: McpEngineAdapter) => Promise<T>): Promise<T> {
  const engine = assembleSemanticEngine(vault);
  try {
    return await fn(engine.adapter);
  } finally {
    await engine.dispose();
  }
}

export async function runSemanticCli(options: SemanticCliRunOptions): Promise<number> {
  const write = options.write ?? ((message: string) => console.log(message));
  const writeError = options.writeError ?? ((message: string) => console.error(message));
  const parsed = parseSemanticArgs(options.argv);
  const command = parsed.positional[0] === "semantic" ? parsed.positional[1] : parsed.positional[0];
  const commandOffset = parsed.positional[0] === "semantic" ? 2 : 1;
  const rest = parsed.positional.slice(commandOffset);
  const vault = options.vault;

  if (!command || command === "help") {
    write(semanticUsageText());
    return 0;
  }

  if (command === "serve" || command === "http") {
    const server = await startSemanticHttpServer({
      vault,
      host: stringOption(parsed, "host"),
      port: numberOption(parsed, "port") ?? 8765,
      index: stringOption(parsed, "index"),
    });
    printJson(write, { available: true, url: server.url });
    await new Promise(() => undefined);
    return 0;
  }

  if (command === "sync" || command === "update" || command === "embed") {
    return withSemanticAdapter(vault, async (adapter) => {
      const result = await adapter.syncEmbeddings({
        vault,
        collection: stringOption(parsed, "collection"),
        index: stringOption(parsed, "index"),
        embed: booleanOption(parsed, "embed"),
        force: booleanOption(parsed, "force"),
        chunkStrategy: stringOption(parsed, "chunkStrategy"),
        maxDocsPerBatch: numberOption(parsed, "maxDocsPerBatch"),
        maxBatchMb: numberOption(parsed, "maxBatchMb"),
      });
      printJson(write, result);
      return result.available ? 0 : 1;
    });
  }

  if (command === "cleanup") {
    return withSemanticAdapter(vault, async (adapter) => {
      const result = await adapter.cleanup({ vault, index: stringOption(parsed, "index") });
      printJson(write, result);
      return result.available ? 0 : 1;
    });
  }

  if (command === "search") {
    return withSemanticAdapter(vault, async (adapter) => {
      const result = await adapter.semanticQuery(semanticQueryOptions("search", vault, parsed, rest.join(" ")));
      printJson(write, result);
      return result.available ? 0 : 1;
    });
  }

  if (command === "collection") return runCollectionCommand(rest[0], rest[1], parsed, vault, write);
  if (command === "context") return runContextCommand(rest[0], parsed, vault, write);

  writeError(semanticUsageText());
  return 1;
}

async function runCollectionCommand(
  action: string | undefined,
  collectionName: string | undefined,
  parsed: ReturnType<typeof parseSemanticArgs>,
  vault: string,
  write: (message: string) => void,
): Promise<number> {
  return withSemanticAdapter(vault, (adapter) => {
    const result = adapter.listCollections({ vault, index: stringOption(parsed, "index") });
    if (!result.available) {
      printJson(write, result);
      return Promise.resolve(1);
    }
    const name = action === "show" ? collectionName : undefined;
    const collections = name ? result.collections.filter((collection) => collection.name === name) : result.collections;
    printJson(write, { collections });
    return Promise.resolve(0);
  });
}

async function runContextCommand(
  action: string | undefined,
  parsed: ReturnType<typeof parseSemanticArgs>,
  vault: string,
  write: (message: string) => void,
): Promise<number> {
  if (action && action !== "list") {
    write(semanticUsageText());
    return 1;
  }
  return withSemanticAdapter(vault, (adapter) => {
    const result = adapter.listContexts({ vault, index: stringOption(parsed, "index") });
    printJson(write, result);
    return Promise.resolve(result.available ? 0 : 1);
  });
}
