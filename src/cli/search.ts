import path from "node:path";

import { runEngineSession } from "./engine-session.js";
import { runIndexCommand, validateIndexFamilyArgs } from "./index-command.js";
import {
  parseSearchArgs,
  printJson,
  searchQueryOptions,
  stringOption,
} from "./search-args.js";
import { searchUsage } from "./search-usage.js";
import { resolveEffectiveVault } from "../kernel/link/link.js";
import {
  retrieveMorningContext,
  type MorningSemanticBackend,
  type MorningRetrieveOptions,
} from "../kernel/search/morning.js";
import type { McpEngineAdapter } from "../kernel/engine/mcp/facade.js";
import type { WriteTargetSource } from "../kernel/conventions/write-protocol.js";
import type { SemanticSearchMode } from "../kernel/search/semantic-contract.js";

interface Target {
  readonly vault: string;
  readonly source: WriteTargetSource;
  readonly argv: readonly string[];
}

function fail(message: string): never {
  throw new Error(`SEARCH_ARGS_INVALID: ${message}`);
}

async function target(argv: readonly string[]): Promise<Target> {
  const rest: string[] = [];
  let explicit: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token !== "--vault") {
      rest.push(token);
      continue;
    }
    if (explicit !== undefined) fail("--vault may be specified only once");
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) fail("--vault requires a value");
    explicit = value;
  }
  if (explicit !== undefined) {
    return { vault: path.resolve(explicit), source: "explicit", argv: rest };
  }
  const resolved = await resolveEffectiveVault(process.cwd(), process.env);
  return { vault: resolved.vault, source: resolved.source, argv: rest };
}

function backend(adapter: McpEngineAdapter, vault: string): MorningSemanticBackend {
  return {
    sync: () => Promise.resolve(undefined),
    status: (options) => Promise.resolve(adapter.semanticStatus(options)),
    query: (options) => adapter.semanticQuery(options),
    getDocument: (options) => adapter.getDocument({ ...options, vault: options.vault ?? vault }),
    multiGet: (options) => adapter.multiGetDocuments({
      ...options,
      vault: options.vault ?? vault,
      targets: [...options.targets],
    }),
  };
}

function contextOptions(vault: string, argv: readonly string[]): MorningRetrieveOptions {
  const values = new Set([
    "template", "folder", "property", "value", "wikilink", "query",
    "limit", "max-neighbors",
  ]);
  const booleans = new Set(["use-cache", "no-use-cache"]);
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) fail(`unexpected context argument ${token}`);
    const name = token.slice(2);
    if (Object.hasOwn(parsed, name)) fail(`--${name} may be specified only once`);
    if (booleans.has(name)) {
      parsed[name] = true;
      continue;
    }
    if (!values.has(name)) fail(`unknown context flag --${name}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) fail(`--${name} requires a value`);
    parsed[name] = value;
  }
  const number = (name: string): number | undefined => {
    const value = parsed[name];
    if (value === undefined) return undefined;
    const result = Number(value);
    if (!Number.isInteger(result) || result < 1) fail(`--${name} must be a positive integer`);
    return result;
  };
  const text = (name: string): string | undefined => {
    const value = parsed[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  return {
    vault,
    template: text("template"),
    folder: text("folder"),
    property: text("property"),
    value: text("value"),
    wikilink: text("wikilink"),
    query: text("query"),
    limit: number("limit"),
    maxNeighbors: number("max-neighbors"),
    useCache: parsed["no-use-cache"] === true ? false : parsed["use-cache"] === true ? true : undefined,
  };
}

async function runSearch(argv: readonly string[]): Promise<void> {
  const resolved = await target(argv);
  const verb = resolved.argv[0];
  if (verb === undefined || verb === "help" || verb === "--help" || verb === "-h") {
    console.log(searchUsage());
    return;
  }
  if (verb === "query") {
    const valueFlags = new Set([
      "collection", "limit", "index", "min-score", "chunk-strategy", "cursor",
      "collection-path", "mode", "folder", "field", "link", "intent", "lex",
      "vec", "hyde", "candidate-limit", "max-queries",
    ]);
    const booleanFlags = new Set([
      "all", "full", "full-path", "expand", "rerank", "no-rerank",
    ]);
    for (let index = 1; index < resolved.argv.length; index += 1) {
      const token = resolved.argv[index]!;
      if (!token.startsWith("--") && token !== "-n" && token !== "-c") continue;
      const name = token === "-n" ? "limit" : token === "-c" ? "collection" : token.slice(2);
      if (!valueFlags.has(name) && !booleanFlags.has(name)) fail(`unknown query flag ${token}`);
      if (valueFlags.has(name)) {
        const value = resolved.argv[++index];
        if (value === undefined || value.startsWith("--")) fail(`${token} requires a value`);
      }
    }
    const args = parseSearchArgs(resolved.argv);
    const query = args.positional.slice(1).join(" ")
      || stringOption(args, "lex")
      || stringOption(args, "vec")
      || stringOption(args, "hyde")
      || "";
    if (!query) fail("search query requires query text or --lex, --vec, or --hyde");
    const requestedMode = stringOption(args, "mode") ?? "query";
    if (requestedMode !== "query" && requestedMode !== "search" && requestedMode !== "vsearch") {
      fail("--mode must be query, search, or vsearch");
    }
    const result = await runEngineSession(resolved.vault, { write: false }, (adapter) =>
      adapter.semanticQuery(searchQueryOptions(requestedMode as SemanticSearchMode, resolved.vault, args, query)));
    printJson(console.log, result);
    if (!result.available) process.exitCode = 1;
    return;
  }
  if (verb === "context") {
    const result = await runEngineSession(resolved.vault, { write: false }, (adapter) =>
      retrieveMorningContext(contextOptions(resolved.vault, resolved.argv.slice(1)), backend(adapter, resolved.vault)));
    printJson(console.log, result);
    return;
  }
  fail(`unknown search subcommand ${verb}`);
}

export { searchUsage } from "./search-usage.js";

export async function runSearchCommand(argv: readonly string[]): Promise<void> {
  process.exitCode = 0;
  try {
    await runSearch(argv);
  } catch (error) {
    process.exitCode = 1;
    console.error(error instanceof Error ? error.message : String(error));
  }
}

export async function runIndexFamilyCommand(argv: readonly string[]): Promise<void> {
  process.exitCode = 0;
  try {
    validateIndexFamilyArgs(argv);
    const resolved = await target(argv);
    await runIndexCommand({
      args: parseSearchArgs(["index", ...resolved.argv]),
      vault: resolved.vault,
      source: resolved.source,
      write: console.log,
      writeError: console.error,
    }).then((code) => {
      process.exitCode = code;
    });
  } catch (error) {
    process.exitCode = 1;
    console.error(error instanceof Error ? error.message : String(error));
  }
}
