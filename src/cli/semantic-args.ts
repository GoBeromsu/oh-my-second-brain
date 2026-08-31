import type { SemanticQueryOptions, SemanticSearchMode } from "../kernel/search/semantic-contract.js";
import type { McpSemanticAxisValue, McpSemanticQueryAxes } from "../kernel/engine/mcp/types.js";

export interface ParsedSemanticArgs {
  readonly positional: readonly string[];
  readonly options: Readonly<Record<string, string | boolean>>;
}

function appendStringOption(
  options: Record<string, string | boolean>,
  key: string,
  value: string,
): void {
  const prior = options[key];
  // A NUL separator distinguishes repeated flags from comma-delimited axis
  // values (`--field tags=one,two --field status=open`). It never appears in a
  // shell argument, so the representation remains unambiguous until the axis
  // object is built below.
  options[key] = typeof prior === "string" && prior.length > 0 ? `${prior}\u0000${value}` : value;
}

export function parseSemanticArgs(argv: readonly string[]): ParsedSemanticArgs {
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--vault") {
      i++;
    } else if (arg === "-c" || arg === "--collection" || arg === "--name") {
      options["collection"] = argv[i + 1] ?? "";
      i++;
    } else if (arg === "-n" || arg === "--limit") {
      options["limit"] = argv[i + 1] ?? "";
      i++;
    } else if (arg === "-l" || arg === "--line-limit") {
      options["lineLimit"] = argv[i + 1] ?? "";
      i++;
    } else if (arg === "--index" || arg === "--min-score" || arg === "--chunk-strategy") {
      options[camelOption(arg)] = argv[i + 1] ?? "";
      i++;
    } else if (
      arg === "--cursor"
      || arg === "--collection-path"
      || arg === "--mode"
      || arg === "--folder"
      || arg === "--field"
      || arg === "--link"
    ) {
      appendStringOption(options, camelOption(arg), argv[i + 1] ?? "");
      i++;
    } else if (arg === "--intent" || arg === "--lex" || arg === "--vec" || arg === "--hyde") {
      options[arg.slice(2)] = argv[i + 1] ?? "";
      i++;
    } else if (arg === "--from-line" || arg === "--line-count" || arg === "--max-bytes") {
      options[camelOption(arg)] = argv[i + 1] ?? "";
      i++;
    } else if (arg === "--pattern" || arg === "--ignore" || arg === "--update-command" || arg === "--host") {
      options[camelOption(arg)] = argv[i + 1] ?? "";
      i++;
    } else if (arg === "--candidate-limit" || arg === "--max-queries" || arg === "--port" || arg === "--max-docs-per-batch" || arg === "--max-batch-mb") {
      options[camelOption(arg)] = argv[i + 1] ?? "";
      i++;
    } else if (arg === "--include-default") {
      options["includeDefault"] = true;
    } else if (arg === "--no-include-default") {
      options["includeDefault"] = false;
    } else if (arg === "--line-numbers" || arg === "--full-path" || arg === "--force" || arg === "--all" || arg === "--full" || arg === "--pull" || arg === "--update" || arg === "--embed" || arg === "--expand" || arg === "--rerank") {
      options[camelOption(arg)] = true;
    } else if (arg === "--no-rerank") {
      options["rerank"] = false;
    } else if (arg === "--no-embed") {
      options["embed"] = false;
    } else if (arg === "--no-line-numbers") {
      options["lineNumbers"] = false;
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function camelOption(arg: string): string {
  return arg.slice(2).replace(/-([a-z])/gu, (_match: string, value: string) => value.toUpperCase());
}

export function stringOption(args: ParsedSemanticArgs, key: string): string | undefined {
  const value = args.options[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function booleanOption(args: ParsedSemanticArgs, key: string): boolean | undefined {
  const value = args.options[key];
  return typeof value === "boolean" ? value : undefined;
}

export function numberOption(args: ParsedSemanticArgs, key: string): number | undefined {
  const value = stringOption(args, key);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function stringListOption(args: ParsedSemanticArgs, key: string): readonly string[] | undefined {
  const value = stringOption(args, key);
  return value ? value.split(",").map((item) => item.trim()).filter((item) => item.length > 0) : undefined;
}

export function printJson(write: (message: string) => void, value: unknown): void {
  write(JSON.stringify(value, null, 2));
}

export function semanticQueryOptions(
  mode: SemanticSearchMode,
  vault: string,
  args: ParsedSemanticArgs,
  query: string,
): SemanticQueryOptions {
  const requestedMode = stringOption(args, "mode");
  if (requestedMode !== undefined && requestedMode !== mode) {
    throw new Error(`CLI mode "${requestedMode}" contradicts the "${mode}" query command.`);
  }
  const axes = queryAxesFromCli(args);
  const vec = stringOption(args, "vec");
  const hyde = stringOption(args, "hyde");
  const expand = booleanOption(args, "expand") === true;
  if (expand && mode !== "query") {
    throw new Error('CLI "--expand" is supported only by the "query" command.');
  }
  if (expand && (vec !== undefined || hyde !== undefined || stringOption(args, "lex") !== undefined || axes !== undefined)) {
    throw new Error('CLI "--expand" conflicts with --lex, --vec, --hyde, and axis filters.');
  }
  // The canonical query mapper now owns lexical-only defaults. Do not duplicate
  // a plain query into an implicit `lex` shorthand here: doing so changes its
  // receipt from plain to explicit and recreates two representations of one
  // request. Only a caller-authored --lex flag becomes a shorthand.
  const lex = stringOption(args, "lex");
  return {
    vault,
    query,
    mode,
    ...(expand
      ? {
        strategy: {
          kind: "expand" as const,
          profile: "qmd-v2.8.3" as const,
          ...(numberOption(args, "maxQueries") === undefined
            ? {}
            : { maxQueries: numberOption(args, "maxQueries") }),
        },
      }
      : {}),
    collection: stringOption(args, "collection"),
    index: stringOption(args, "index"),
    limit: numberOption(args, "limit"),
    minScore: numberOption(args, "minScore"),
    intent: stringOption(args, "intent"),
    lex,
    vec,
    hyde,
    cursor: stringOption(args, "cursor"),
    collectionPath: stringOption(args, "collectionPath"),
    ...(axes === undefined ? {} : { axes }),
    all: booleanOption(args, "all"),
    full: booleanOption(args, "full"),
    fullPath: booleanOption(args, "fullPath"),
    candidateLimit: numberOption(args, "candidateLimit"),
    rerank: booleanOption(args, "rerank"),
  };
}

function axisScalar(value: string): McpSemanticAxisValue {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  // Keep values such as "001" as strings; they are commonly identifiers, not
  // numbers. Decimal and signed integer forms retain their typed axis meaning.
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return trimmed;
}

function axisList(
  value: string | undefined,
): McpSemanticAxisValue | readonly McpSemanticAxisValue[] | undefined {
  if (value === undefined) return undefined;
  const values = value
    .split(/[,\u0000]/u)
    .map((item) => axisScalar(item))
    .filter((item) => typeof item !== "string" || item.length > 0);
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values;
}

function queryAxesFromCli(args: ParsedSemanticArgs): McpSemanticQueryAxes | undefined {
  const folder = axisList(stringOption(args, "folder"));
  const link = axisList(stringOption(args, "link"));
  const fieldsRaw = stringOption(args, "field");
  let field: Record<string, McpSemanticAxisValue | readonly McpSemanticAxisValue[]> | undefined;
  if (fieldsRaw !== undefined) {
    field = {};
    for (const entry of fieldsRaw.split("\u0000")) {
      const separator = entry.indexOf("=");
      const colon = entry.indexOf(":");
      const splitAt = separator >= 0 ? separator : colon;
      if (splitAt <= 0) {
        throw new Error(`Invalid --field "${entry}". Use --field name=value.`);
      }
      const key = entry.slice(0, splitAt).trim();
      const value = axisList(entry.slice(splitAt + 1));
      if (!key || value === undefined) {
        throw new Error(`Invalid --field "${entry}". Use --field name=value.`);
      }
      const prior = field[key];
      if (prior === undefined) {
        field[key] = value;
      } else {
        const priorValues = Array.isArray(prior) ? prior : [prior];
        const nextValues = Array.isArray(value) ? value : [value];
        field[key] = [...priorValues, ...nextValues];
      }
    }
  }
  if (folder === undefined && link === undefined && field === undefined) return undefined;
  return {
    ...(folder === undefined ? {} : { folder }),
    ...(field === undefined ? {} : { field }),
    ...(link === undefined ? {} : { link }),
  };
}

export function targetList(values: readonly string[]): readonly string[] {
  return values.flatMap((value) => value.split(",").map((item) => item.trim()).filter((item) => item.length > 0));
}
