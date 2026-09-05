import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { writeResolvedTemplateNote } from "../kernel/capture/safe.js";
import type { WriteTargetSource } from "../kernel/conventions/write-protocol.js";
import { resolveEffectiveVault } from "../kernel/link/link.js";
import { backfillDefaults } from "../kernel/templates/doctor.js";
import { loadResolvedTemplates } from "../kernel/templates/resolver.js";
import type { Digest, JsonValue } from "../kernel/templates/types.js";
import { runAudit } from "./audit.js";
import { getNoteDocuments } from "./doc-command.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_INPUT_BYTES = 1_048_576;
const VALUE_FLAGS = new Set([
  "vault", "body", "body-file", "frontmatter", "frontmatter-file", "resolved-at",
  "folder", "max-per-template", "approved-digest", "note-path", "collection",
  "from-line", "line-count", "line-limit", "max-bytes",
]);
const BOOLEAN_FLAGS = new Set(["dry-run", "yes", "json", "line-numbers", "full-path", "help"]);

type Options = Readonly<Record<string, string | boolean>>;
interface Parsed {
  readonly verb: string;
  readonly positional: readonly string[];
  readonly options: Options;
}
interface Target {
  readonly vault: string;
  readonly source: WriteTargetSource;
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
    if (Object.hasOwn(options, name)) fail(`duplicate flag --${name}`);
    if (BOOLEAN_FLAGS.has(name)) {
      options[name] = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) fail(`--${name} requires a value`);
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

async function target(options: Options): Promise<Target> {
  const explicit = text(options, "vault");
  if (explicit !== undefined) return { vault: path.resolve(explicit), source: "explicit" };
  const resolved = await resolveEffectiveVault(process.cwd(), process.env);
  return { vault: resolved.vault, source: resolved.source };
}

async function boundedText(filename: string): Promise<string> {
  const size = (await stat(filename)).size;
  if (size > MAX_INPUT_BYTES) fail(`input file exceeds ${MAX_INPUT_BYTES} bytes`);
  const bytes = await readFile(filename);
  if (bytes.byteLength > MAX_INPUT_BYTES) fail(`input file exceeds ${MAX_INPUT_BYTES} bytes`);
  return bytes.toString("utf8");
}

async function exclusiveText(options: Options, inlineName: string, fileName: string): Promise<string | undefined> {
  const inline = text(options, inlineName);
  const filename = text(options, fileName);
  if (inline !== undefined && filename !== undefined) fail(`--${inlineName} conflicts with --${fileName}`);
  return inline ?? (filename === undefined ? undefined : boundedText(filename));
}

function frontmatterObject(raw: string | undefined): Readonly<Record<string, JsonValue>> | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("--frontmatter input must be valid JSON");
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail("--frontmatter input must be a JSON object");
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function positiveInteger(options: Options, name: string): number | undefined {
  const raw = text(options, name);
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/u.test(raw)) fail(`--${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) fail(`--${name} must be a safe positive integer`);
  return value;
}

function print(value: unknown): void {
  const status = value !== null && typeof value === "object" && "status" in value
    ? (value as { readonly status?: unknown }).status
    : undefined;
  if (status === "ask" || status === "rejected" || status === "needs-repair") process.exitCode = 1;
  console.log(JSON.stringify(value, null, 2));
}

async function runWrite(parsed: Parsed): Promise<void> {
  if (parsed.verb !== "create" && parsed.verb !== "append" && parsed.verb !== "update") {
    fail(`unknown write verb ${parsed.verb}`);
  }
  const mode = parsed.verb;
  const common = ["vault", "dry-run", "body", "body-file", "resolved-at"];
  if (mode === "create") {
    only(parsed, [...common, "frontmatter", "frontmatter-file"], [0, 1]);
  } else if (mode === "append") {
    only(parsed, common, 1);
  } else {
    only(parsed, [...common, "frontmatter", "frontmatter-file"], 1);
  }
  const body = await exclusiveText(parsed.options, "body", "body-file");
  const frontmatter = frontmatterObject(await exclusiveText(parsed.options, "frontmatter", "frontmatter-file"));
  if ((mode === "create" || mode === "append") && body === undefined) fail(`${mode} requires --body or --body-file`);
  if (mode === "update" && body === undefined && frontmatter === undefined) fail("update requires body or frontmatter input");
  const resolved = await target(parsed.options);
  const convention = await loadResolvedTemplates(resolved.vault);
  print(await writeResolvedTemplateNote({
    target: resolved,
    convention,
    mode,
    dryRun: flag(parsed.options, "dry-run"),
    ...(mode === "create"
      ? { ...(parsed.positional[0] === undefined ? {} : { templateId: parsed.positional[0] }) }
      : { notePath: parsed.positional[0] }),
    ...(body === undefined ? {} : { body }),
    ...(frontmatter === undefined ? {} : { frontmatter }),
    ...(text(parsed.options, "resolved-at") === undefined ? {} : { resolvedAt: text(parsed.options, "resolved-at") }),
  }));
}

function backfillGuard(options: Options): { readonly dryRun: true } | { readonly approvedDigest: Digest } {
  const dryRun = flag(options, "dry-run");
  const yes = flag(options, "yes");
  const approvedDigest = text(options, "approved-digest");
  if (dryRun) {
    if (yes || approvedDigest !== undefined) fail("--dry-run conflicts with --yes and --approved-digest");
    return { dryRun: true };
  }
  if (!yes || approvedDigest === undefined || !DIGEST.test(approvedDigest)) {
    fail("backfill requires --dry-run or --yes --approved-digest sha256:<64hex>");
  }
  return { approvedDigest: approvedDigest as Digest };
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
  if (parsed.verb === "create" || parsed.verb === "append" || parsed.verb === "update") {
    await runWrite(parsed);
    return;
  }
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
  if (parsed.verb === "backfill") {
    only(parsed, ["vault", "dry-run", "yes", "approved-digest"], 1);
    const resolved = await target(parsed.options);
    print(await backfillDefaults({
      target: resolved,
      notePath: parsed.positional[0]!,
      request: backfillGuard(parsed.options),
    }));
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

  create [template-id] --body <text>|--body-file <file> [--frontmatter <json>|--frontmatter-file <file>]
  append <note-path> --body <text>|--body-file <file>
  update <note-path> [--body <text>|--body-file <file>] [--frontmatter <json>|--frontmatter-file <file>]
  audit [--folder <folder>] [--max-per-template <count>]
  backfill <note-path> (--dry-run | --yes --approved-digest <digest>)
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
    print({
      status: "rejected",
      diagnostics: [{
        code: error instanceof Error ? error.message.split(":", 1)[0] : "NOTE_COMMAND_FAILED",
        remediation: error instanceof Error ? error.message : String(error),
      }],
    });
  }
}
