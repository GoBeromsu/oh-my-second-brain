import path from "node:path";

import type { WriteTarget } from "../kernel/capture/safe.js";
import { resolveEffectiveVault } from "../kernel/link/link.js";
import { runAudit } from "./audit.js";
import { getNoteDocuments } from "./doc-command.js";

const VALUE_FLAGS = new Set([
  "vault", "note-path", "folder", "max-per-template", "collection", "from-line", "line-count", "line-limit", "max-bytes",
]);
const BOOLEAN_FLAGS = new Set(["json", "line-numbers", "full-path", "help"]);

type Options = Readonly<Record<string, string | boolean>>;
interface Parsed {
  readonly verb: string;
  readonly positional: readonly string[];
  readonly options: Options;
}

function fail(message: string): never {
  throw new Error(`NOTE_ARGS_INVALID: ${message}`);
}

function parse(argv: readonly string[]): Parsed {
  if (argv.length === 0) fail("missing note verb");
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      if (token.startsWith("-")) fail(`unknown flag ${token}`);
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) fail(`unknown flag --${name}`);
    if (BOOLEAN_FLAGS.has(name)) {
      if (Object.hasOwn(options, name)) fail(`duplicate flag --${name}`);
      options[name] = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) fail(`--${name} requires a value`);
    if (Object.hasOwn(options, name)) fail(`duplicate flag --${name}`);
    options[name] = value;
  }
  return { verb: argv[0]!, positional, options };
}

function text(options: Options, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

function flag(options: Options, name: string): boolean {
  return options[name] === true;
}

function only(parsed: Parsed, allowed: readonly string[], positional: number | readonly [number, number]): void {
  const unexpected = Object.keys(parsed.options).find(key => !allowed.includes(key));
  if (unexpected !== undefined) fail(`--${unexpected} is not valid for ${parsed.verb}`);
  const [minimum, maximum] = typeof positional === "number" ? [positional, positional] : positional;
  if (parsed.positional.length < minimum || parsed.positional.length > maximum) {
    fail(`${parsed.verb} expects ${minimum === maximum ? String(minimum) : `${minimum}-${maximum}`} positional argument(s)`);
  }
}

async function target(options: Options): Promise<WriteTarget> {
  const explicit = text(options, "vault");
  if (explicit !== undefined) return { vault: path.resolve(explicit), source: "explicit" };
  const resolved = await resolveEffectiveVault(process.cwd(), process.env);
  return { vault: resolved.vault, source: resolved.source };
}

function positiveInteger(options: Options, name: string): number | undefined {
  const raw = text(options, name);
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/u.test(raw)) fail(`--${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) fail(`--${name} must be a safe positive integer`);
  return value;
}

async function runGet(parsed: Parsed): Promise<void> {
  only(parsed, ["vault", "note-path", "collection", "from-line", "line-count", "line-limit", "max-bytes", "line-numbers", "full-path"], [0, Number.MAX_SAFE_INTEGER]);
  const notePath = text(parsed.options, "note-path");
  const fromLine = positiveInteger(parsed.options, "from-line");
  const lineCount = positiveInteger(parsed.options, "line-count");
  const lineLimit = positiveInteger(parsed.options, "line-limit");
  const maxBytes = positiveInteger(parsed.options, "max-bytes");
  if (notePath !== undefined) {
    if (parsed.positional.length > 0) fail("--note-path conflicts with positional targets");
    if (fromLine === undefined && lineCount === undefined) fail("--note-path requires --from-line or --line-count");
    if (lineLimit !== undefined || maxBytes !== undefined) fail("--note-path window conflicts with multi-target limits");
  } else {
    if (parsed.positional.length === 0) fail("get requires one or more targets or --note-path with a window");
    if (parsed.positional.length > 1 && (fromLine !== undefined || lineCount !== undefined)) fail("window flags require one target");
    if (parsed.positional.length === 1 && (lineLimit !== undefined || maxBytes !== undefined)) fail("multi-target limits require multiple targets");
  }
  const resolved = await target(parsed.options);
  const code = await getNoteDocuments({
    vault: resolved.vault,
    ...(notePath !== undefined
      ? { notePath, fromLine, lineCount }
      : parsed.positional.length === 1
        ? { target: parsed.positional[0], fromLine, lineCount }
        : { targets: parsed.positional, lineLimit, maxBytes }),
    collection: text(parsed.options, "collection"),
    lineNumbers: flag(parsed.options, "line-numbers") || undefined,
    fullPath: flag(parsed.options, "full-path") || undefined,
    write: message => console.log(message),
  });
  process.exitCode = code;
}

async function run(parsed: Parsed): Promise<void> {
  if (parsed.verb === "audit") {
    only(parsed, ["vault", "folder", "max-per-template", "json"], 0);
    const resolved = await target(parsed.options);
    process.exitCode = await runAudit({
      vault: resolved.vault,
      folder: text(parsed.options, "folder"),
      maxPerTemplate: positiveInteger(parsed.options, "max-per-template"),
      json: flag(parsed.options, "json"),
    });
    return;
  }
  if (parsed.verb === "get") {
    await runGet(parsed);
    return;
  }
  fail(`unknown note verb ${parsed.verb}`);
}

export function noteUsage(): string {
  return `Usage: oms note <verb> [options]

Leaves: audit | get

  audit [--folder <folder>] [--max-per-template <count>] [--json] [--vault <vault>]
  get <target...> | get --note-path <path> (--from-line <line>|--line-count <count>)`;
}

export async function runNoteCommand(argv: readonly string[]): Promise<void> {
  process.exitCode = 0;
  try {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
      console.log(noteUsage());
      return;
    }
    const parsed = parse(argv);
    if (flag(parsed.options, "help")) {
      console.log(noteUsage());
      return;
    }
    await run(parsed);
  } catch (error: unknown) {
    process.exitCode = 1;
    console.log(JSON.stringify({
      status: "rejected",
      diagnostics: [{
        code: error instanceof Error ? error.message.split(":", 1)[0] : "NOTE_COMMAND_FAILED",
        remediation: error instanceof Error ? error.message : String(error),
      }],
    }, null, 2));
  }
}
