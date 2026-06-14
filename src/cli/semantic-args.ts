import type { SemanticQueryOptions, SemanticSearchMode, SemanticStorage } from "../search/semantic.js";

export interface ParsedSemanticArgs {
  readonly positional: readonly string[];
  readonly options: Readonly<Record<string, string | boolean>>;
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
    } else if (arg === "--index" || arg === "--min-score" || arg === "--chunk-strategy" || arg === "--storage" || arg === "--model-path") {
      options[camelOption(arg)] = argv[i + 1] ?? "";
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
    } else if (arg === "--candidate-limit" || arg === "--port" || arg === "--max-docs-per-batch" || arg === "--max-batch-mb") {
      options[camelOption(arg)] = argv[i + 1] ?? "";
      i++;
    } else if (arg === "--include-default") {
      options["includeDefault"] = true;
    } else if (arg === "--no-include-default") {
      options["includeDefault"] = false;
    } else if (arg === "--line-numbers" || arg === "--full-path" || arg === "--force" || arg === "--all" || arg === "--full" || arg === "--pull" || arg === "--update" || arg === "--embed") {
      options[camelOption(arg)] = true;
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

export function semanticStorageOption(args: ParsedSemanticArgs, key = "storage"): SemanticStorage | undefined {
  const value = stringOption(args, key);
  return value === "qmd-sqlite" || value === "oms-native-json" ? value : undefined;
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
  return {
    vault,
    query,
    mode,
    collection: stringOption(args, "collection"),
    index: stringOption(args, "index"),
    storage: semanticStorageOption(args),
    modelPath: stringOption(args, "modelPath"),
    limit: numberOption(args, "limit"),
    minScore: numberOption(args, "minScore"),
    intent: stringOption(args, "intent"),
    lex: stringOption(args, "lex"),
    vec: stringOption(args, "vec"),
    hyde: stringOption(args, "hyde"),
    all: booleanOption(args, "all"),
    full: booleanOption(args, "full"),
    fullPath: booleanOption(args, "fullPath"),
    candidateLimit: numberOption(args, "candidateLimit"),
  };
}

export function targetList(values: readonly string[]): readonly string[] {
  return values.flatMap((value) => value.split(",").map((item) => item.trim()).filter((item) => item.length > 0));
}
