import path from "node:path";

import type { runEngineSession } from "./engine-session.js";
import {
  parseSearchArgs,
  printJson,
  searchQueryOptions,
  stringOption,
} from "./search-args.js";
import { searchUsage } from "./search-usage.js";
import { readExactDocument } from "../kernel/search/read-exact.js";
import type { MorningSemanticBackend, MorningRetrieveOptions } from "../kernel/search/morning.js";
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

/** Injection point: `search --path` must reach `readExactDocument` and never `runEngineSession`. */
export interface SearchCommandDeps {
  readonly readExactDocument: typeof readExactDocument;
  readonly runEngineSession: typeof runEngineSession;
  readonly runLinkFamilyCommand: (argv: readonly string[]) => Promise<void>;
}

// The engine, index, link and morning-context modules load only on the branches that use them,
// so `search --path` stays off the engine's import graph.
const DEFAULT_DEPS: SearchCommandDeps = {
  readExactDocument,
  runEngineSession: async (vault, options, fn) =>
    (await import("./engine-session.js")).runEngineSession(vault, options, fn),
  runLinkFamilyCommand: async (argv) => (await import("./link-command.js")).runLinkFamilyCommand(argv),
};

async function target(argv: readonly string[]): Promise<Target> {
  const rest: string[] = [];
  let explicit: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    // Tokens after a `--` terminator are query text, so a later `--vault` is not the flag.
    if (token === "--") {
      rest.push(...argv.slice(index));
      break;
    }
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
  const { resolveEffectiveVault } = await import("../kernel/link/link.js");
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

/** `oms search --path <rel>`: an engine-free exact read. Any other argument is refused. */
async function runPathRead(resolved: Target, deps: SearchCommandDeps): Promise<void> {
  const [, relPath, ...extra] = resolved.argv;
  if (relPath === undefined || relPath.startsWith("--")) fail("--path requires a vault-relative note path");
  if (extra.length > 0) {
    fail("--path is mutually exclusive with search subcommands, query text, and mode flags");
  }
  const result = await deps.readExactDocument(resolved.vault, relPath);
  printJson(console.log, result);
  if (!result.available) process.exitCode = 1;
}

async function runSearch(argv: readonly string[], deps: SearchCommandDeps): Promise<void> {
  const resolved = await target(argv);
  if (resolved.argv[0] === "--path") {
    await runPathRead(resolved, deps);
    return;
  }
  // Tokens after a `--` terminator are query text, never flags.
  const terminator = resolved.argv.indexOf("--");
  const flagged = terminator === -1 ? resolved.argv : resolved.argv.slice(0, terminator);
  const literal = terminator === -1 ? [] : resolved.argv.slice(terminator + 1);
  if (flagged.includes("--path")) {
    fail("--path is mutually exclusive with search subcommands, query text, and mode flags");
  }
  const first = resolved.argv[0];
  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    console.log(searchUsage());
    return;
  }
  if (first === "query" || first === "context") {
    fail(
      first === "query"
        ? "`search query` was removed in 0.19; run `oms search <text>` (use `oms search -- query ...` to search for the word itself)"
        : "`search context` was removed in 0.19; run `oms search --context [options]`",
    );
  }
  if (first === "--link") {
    // A leading --link is link suggestion for one note; later --link stays a query filter.
    // The resolved argv already had --vault removed, so an explicit target is passed on resolved.
    const vault = resolved.source === "explicit" ? ["--vault", resolved.vault] : [];
    await deps.runLinkFamilyCommand(["suggest", ...resolved.argv.slice(1), ...vault]);
    return;
  }
  if (first === "--context") {
    const { retrieveMorningContext } = await import("../kernel/search/morning.js");
    const result = await deps.runEngineSession(resolved.vault, { write: false }, (adapter) =>
      retrieveMorningContext(contextOptions(resolved.vault, resolved.argv.slice(1)), backend(adapter, resolved.vault)));
    printJson(console.log, result);
    return;
  }
  if (flagged.includes("--context")) fail("--context must be the first search argument");
  const valueFlags = new Set([
    "collection", "limit", "index", "min-score", "chunk-strategy", "cursor",
    "collection-path", "mode", "folder", "field", "link", "intent", "lex",
    "vec", "hyde", "candidate-limit", "max-queries",
  ]);
  const booleanFlags = new Set([
    "all", "full", "full-path", "expand", "rerank", "no-rerank",
  ]);
  for (let index = 0; index < flagged.length; index += 1) {
    const token = flagged[index]!;
    if (!token.startsWith("--") && token !== "-n" && token !== "-c") continue;
    const name = token === "-n" ? "limit" : token === "-c" ? "collection" : token.slice(2);
    if (!valueFlags.has(name) && !booleanFlags.has(name)) fail(`unknown query flag ${token}`);
    if (valueFlags.has(name)) {
      const value = flagged[++index];
      if (value === undefined || value.startsWith("--")) fail(`${token} requires a value`);
    }
  }
  // The query parser treats its first positional as the verb, so the implicit verb is supplied here.
  const args = parseSearchArgs(["query", ...flagged]);
  const query = [...args.positional.slice(1), ...literal].join(" ")
    || stringOption(args, "lex")
    || stringOption(args, "vec")
    || stringOption(args, "hyde")
    || "";
  if (!query) fail("search requires query text or --lex, --vec, or --hyde");
  const requestedMode = stringOption(args, "mode") ?? "query";
  if (requestedMode !== "query" && requestedMode !== "search" && requestedMode !== "vsearch") {
    fail("--mode must be query, search, or vsearch");
  }
  const result = await deps.runEngineSession(resolved.vault, { write: false }, (adapter) =>
    adapter.semanticQuery(searchQueryOptions(requestedMode as SemanticSearchMode, resolved.vault, args, query)));
  printJson(console.log, result);
  if (!result.available) process.exitCode = 1;
}

export { searchUsage } from "./search-usage.js";

export async function runSearchCommand(
  argv: readonly string[],
  deps: SearchCommandDeps = DEFAULT_DEPS,
): Promise<void> {
  process.exitCode = 0;
  try {
    await runSearch(argv, deps);
  } catch (error) {
    process.exitCode = 1;
    console.error(error instanceof Error ? error.message : String(error));
  }
}

export async function runIndexFamilyCommand(argv: readonly string[]): Promise<void> {
  process.exitCode = 0;
  try {
    const { runIndexCommand, validateIndexFamilyArgs } = await import("./index-command.js");
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
