import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { resolveEffectiveVault } from "../kernel/link/link.js";
import { summarizeRuntimeHistory } from "../kernel/runtime/event-summary.js";
import { composeTemplateAdd } from "../kernel/templates/compose-add.js";
import { diagnoseTemplates, regenerateTypes } from "../kernel/templates/doctor.js";
import { nextTemplateInterview, answerTemplateInterview, commitTemplateContracts } from "../kernel/templates/interview-service.js";
import { executeTemplateOperation } from "../kernel/templates/operations.js";
import { repairPendingTemplateSource } from "../kernel/templates/pending-source.js";
import { readTemplateReviewContext } from "../kernel/templates/review-context.js";
import { deriveTemplateSourcePath, normalizeTemplateFolderPath, normalizeTemplateSourcePath, validateTemplateId } from "../kernel/templates/paths.js";
import { parseTemplatePolicy } from "../kernel/templates/policy.js";
import { classifyTemplateRenderer } from "../kernel/templates/renderer.js";
import { loadResolvedTemplates } from "../kernel/templates/resolver.js";
import { resumeTemplateTransaction, TEMPLATE_MUTATION_MARKER_PATH } from "../kernel/templates/transaction.js";
import type { Digest, GuardedTemplateRequest, JsonValue, TemplateBinding, TemplatePolicy, TemplateRenderer, TemplateSemanticChange } from "../kernel/templates/types.js";
import type { TemplateOperationTarget } from "../kernel/templates/operations.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_SOURCE_BYTES = 262_144;
const DEFAULT_NAMING = "{{date}}-{{slug}}.md";

type Options = Record<string, string | boolean>;
interface Parsed { readonly verb: string; readonly positional: readonly string[]; readonly options: Options; }
type Target = TemplateOperationTarget;

const VALUE_FLAGS = new Set(["vault", "approved-digest", "id", "template-id", "contract", "naming", "renderer", "folder", "from", "path", "expected-source-digest", "class", "resume", "answer", "census-digest", "ledger-digest"]);
const BOOLEAN_FLAGS = new Set(["dry-run", "yes", "creation-default", "delete-source", "help"]);

function fail(message: string): never { throw new Error(`TEMPLATE_ARGS_INVALID: ${message}`); }
function parse(argv: readonly string[]): Parsed {
  if (argv.length === 0) fail("missing template verb");
  const verb = argv[0]!;
  const positional: string[] = [];
  const options: Options = {};
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
    if (BOOLEAN_FLAGS.has(name)) { options[name] = true; continue; }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) fail(`--${name} requires a value`);
    options[name] = value;
  }
  return { verb, positional, options };
}
function text(options: Options, name: string): string | undefined { const value = options[name]; return typeof value === "string" ? value : undefined; }
function flag(options: Options, name: string): boolean { return options[name] === true; }
function jsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(jsonValue);
}
function answerValue(options: Options): JsonValue {
  const raw = text(options, "answer");
  if (raw === undefined) fail("--answer requires a value");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("--answer must be valid JSON");
  }
  if (!jsonValue(value)) fail("--answer must be a JSON value");
  return value;
}
function requiredDigest(options: Options, name: string): Digest {
  const raw = text(options, name);
  if (raw === undefined) fail(`--${name} requires a value`);
  if (!DIGEST.test(raw)) fail(`--${name} must be sha256:<64hex>`);
  return raw as Digest;
}
function expectedLedgerDigest(options: Options): Digest | null {
  const raw = text(options, "ledger-digest");
  if (raw === undefined) fail("--ledger-digest requires a value");
  if (raw === "null") return null;
  if (!DIGEST.test(raw)) fail("--ledger-digest must be null or sha256:<64hex>");
  return raw as Digest;
}
function only(parsed: Parsed, allowed: readonly string[], positional: number | readonly [number, number]): void {
  const unexpected = Object.keys(parsed.options).filter(key => !allowed.includes(key));
  if (unexpected.length > 0) fail(`--${unexpected[0]} is not valid for ${parsed.verb}`);
  const [minimum, maximum] = typeof positional === "number" ? [positional, positional] : positional;
  if (parsed.positional.length < minimum || parsed.positional.length > maximum) fail(`${parsed.verb} expects ${minimum === maximum ? String(minimum) : `${minimum}-${maximum}`} positional argument(s)`);
}
async function target(options: Options): Promise<Target> {
  const explicit = text(options, "vault");
  if (explicit !== undefined) return { vault: path.resolve(explicit), source: "explicit" };
  const resolved = await resolveEffectiveVault(process.cwd(), process.env);
  return { vault: resolved.vault, source: resolved.source };
}
function guard(options: Options): GuardedTemplateRequest {
  const dryRun = flag(options, "dry-run");
  const yes = flag(options, "yes");
  const approved = text(options, "approved-digest");
  if (dryRun) {
    if (yes || approved !== undefined) fail("--dry-run conflicts with --yes and --approved-digest");
    return { dryRun: true };
  }
  if (!yes || approved === undefined || !DIGEST.test(approved)) fail("mutation requires --dry-run or --yes --approved-digest sha256:<64hex>");
  return { approvedDigest: approved as Digest };
}
function ensureMutableTarget(value: Target): void {
  if (value.source === "cwd") fail("mutations require --vault or an existing verified vault/bridge/env target");
}
async function policy(vault: string): Promise<TemplatePolicy> {
  return parseTemplatePolicy(await readFile(path.join(vault, ".oms", "template-policy.json"), "utf8"));
}
function knownContract(value: TemplatePolicy, requested: string | undefined): string {
  const contract = requested ?? "base";
  if (value.contracts[contract] === undefined) throw new Error(`TEMPLATE_CONTRACT_UNKNOWN: contract ${contract} does not exist`);
  return contract;
}
function renderer(value: string | undefined): TemplateRenderer | undefined {
  if (value === undefined) return undefined;
  if (value !== "obsidian-core" && value !== "templater" && value !== "none") fail("--renderer must be obsidian-core, templater, or none");
  return value;
}
async function boundedFile(filename: string): Promise<Uint8Array> {
  const size = (await stat(filename)).size;
  if (size > MAX_SOURCE_BYTES) throw new Error(`TEMPLATE_PROPOSAL_OVERSIZE: source exceeds ${MAX_SOURCE_BYTES} bytes`);
  const bytes = new Uint8Array(await readFile(filename));
  if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error(`TEMPLATE_PROPOSAL_OVERSIZE: source exceeds ${MAX_SOURCE_BYTES} bytes`);
  return bytes;
}
function print(value: unknown): void {
  if (value !== null && typeof value === "object" && "status" in value) {
    const status = (value as { readonly status?: unknown }).status;
    if (status === "rejected" || status === "inconsistent") process.exitCode = 1;
  }
  if (value !== null && typeof value === "object" && "state" in value) {
    if ((value as { readonly state?: unknown }).state === "blocked") process.exitCode = 1;
  }
  console.log(JSON.stringify(value, null, 2));
}
function summarizedScan(context: Awaited<ReturnType<typeof readTemplateReviewContext>>): unknown {
  const entries = context.census.entries.map(entry => ({
    sourcePath: entry.sourcePath,
    ...(entry.templateId === undefined ? {} : { templateId: entry.templateId }),
    signature: entry.signature,
    diagnostics: entry.diagnostics,
  }));
  return {
    entries,
    diffs: context.census.diffs,
    diagnostics: context.census.diagnostics,
    projectionUsable: context.projectionUsable,
    freshTemplateIds: context.freshTemplateIds,
  };
}

async function mutate(parsed: Parsed, change: TemplateSemanticChange): Promise<void> {
  const resolved = await target(parsed.options);
  ensureMutableTarget(resolved);
  print(await executeTemplateOperation(resolved, change, guard(parsed.options)));
}

async function run(parsed: Parsed): Promise<void> {
  if (parsed.verb === "list" || parsed.verb === "show") {
    only(parsed, ["vault"], parsed.verb === "list" ? 0 : 1);
    const resolved = await target(parsed.options);
    const convention = await loadResolvedTemplates(resolved.vault);
    if (parsed.verb === "list") {
      print({ templates: Object.values(convention.templates), inputSignature: convention.inputSignature, history: summarizeRuntimeHistory({ vaultPath: resolved.vault }) });
      return;
    }
    const id = validateTemplateId(parsed.positional[0]!);
    const found = convention.templates[id];
    if (found === undefined) throw new Error(`TEMPLATE_NOT_FOUND: ${id}`);
    print({ template: found, inputSignature: convention.inputSignature }); return;
  }
  if (parsed.verb === "scan") {
    only(parsed, ["vault"], 0);
    const resolved = await target(parsed.options);
    print(summarizedScan(await readTemplateReviewContext(resolved.vault))); return;
  }
  if (parsed.verb === "review") {
    only(parsed, ["vault", "template-id"], 0);
    const resolved = await target(parsed.options);
    print(await nextTemplateInterview(resolved, text(parsed.options, "template-id"))); return;
  }
  if (parsed.verb === "answer") {
    only(parsed, ["vault", "template-id", "answer", "census-digest", "ledger-digest"], 1);
    const resolved = await target(parsed.options);
    ensureMutableTarget(resolved);
    const questionId = parsed.positional[0]!;
    if (!DIGEST.test(questionId)) fail("answer requires a sha256:<64hex> question id");
    print(await answerTemplateInterview(resolved, {
      ...(text(parsed.options, "template-id") === undefined ? {} : { templateId: text(parsed.options, "template-id") }),
      questionId: questionId as Digest,
      answer: answerValue(parsed.options),
      censusDigest: requiredDigest(parsed.options, "census-digest"),
      expectedLedgerDigest: expectedLedgerDigest(parsed.options),
    })); return;
  }
  if (parsed.verb === "commit") {
    only(parsed, ["vault", "template-id", "census-digest", "ledger-digest", "dry-run", "yes", "approved-digest"], 0);
    const resolved = await target(parsed.options);
    ensureMutableTarget(resolved);
    print(await commitTemplateContracts(resolved, {
      ...(text(parsed.options, "template-id") === undefined ? {} : { templateId: text(parsed.options, "template-id") }),
      censusDigest: requiredDigest(parsed.options, "census-digest"),
      expectedLedgerDigest: expectedLedgerDigest(parsed.options),
      ...guard(parsed.options),
    })); return;
  }
  if (parsed.verb === "check") {
    only(parsed, ["vault"], 0);
    const resolved = await target(parsed.options);
    print({ ...await diagnoseTemplates(resolved), vault: resolved.vault }); return;
  }
  if (parsed.verb === "regenerate-types") {
    only(parsed, ["vault", "dry-run", "yes", "approved-digest"], 0);
    const resolved = await target(parsed.options); ensureMutableTarget(resolved);
    print(await regenerateTypes({ target: resolved, request: guard(parsed.options) })); return;
  }
  if (parsed.verb === "add") {
    only(parsed, ["vault", "dry-run", "yes", "approved-digest", "creation-default", "id", "contract", "naming", "renderer", "folder", "from"], [0, 1]);
    const resolved = await target(parsed.options); ensureMutableTarget(resolved);
    const request = guard(parsed.options);
    const idText = text(parsed.options, "id");
    const from = text(parsed.options, "from");
    if (idText === undefined && from === undefined) {
      if (parsed.positional.length !== 1) fail("add <folder> requires one folder");
      if (text(parsed.options, "contract") !== undefined || text(parsed.options, "naming") !== undefined || text(parsed.options, "renderer") !== undefined || text(parsed.options, "folder") !== undefined) fail("add <folder> accepts only the selected folder, --creation-default, and mutation guard");
      print(await executeTemplateOperation(resolved, {
        mode: "register-folder",
        folder: { path: normalizeTemplateFolderPath(parsed.positional[0]!), ...(flag(parsed.options, "creation-default") ? { default: true as const } : {}) },
      }, request)); return;
    }
    if (idText === undefined) fail("template add requires --id");
    const id = validateTemplateId(idText);
    const current = await policy(resolved.vault);
    const contract = knownContract(current, text(parsed.options, "contract"));
    const naming = text(parsed.options, "naming") ?? DEFAULT_NAMING;
    if (from !== undefined) {
      if (parsed.positional.length !== 0 || text(parsed.options, "renderer") !== undefined || flag(parsed.options, "creation-default")) fail("add --from conflicts with a positional source and folder selection flags");
      const composed = composeTemplateAdd(current.templateFolders, { templateId: id, sourceFolder: text(parsed.options, "folder"), bytes: await boundedFile(from), contract, naming });
      print(await executeTemplateOperation(resolved, { mode: "create", binding: composed.binding, source: composed.source }, request)); return;
    }
    fail("template add requires --from for source authoring; per-file registration is not supported");
  }
  if (parsed.verb === "update") {
    only(parsed, ["vault", "dry-run", "yes", "approved-digest", "contract", "naming", "renderer", "path", "from", "expected-source-digest", "class", "resume"], [0, 1]);
    const resume = text(parsed.options, "resume");
    if (resume !== undefined) {
      if (parsed.positional.length !== 0 || ["contract", "naming", "renderer", "path", "from", "expected-source-digest", "class"].some(name => text(parsed.options, name) !== undefined)) fail("--resume conflicts with update fields and template id");
      const resolved = await target(parsed.options); ensureMutableTarget(resolved);
      const request = guard(parsed.options);
      if (request.approvedDigest === undefined) fail("--resume requires approved apply, not --dry-run");
      print(await resumeTemplateTransaction(resolved.vault, resume, request.approvedDigest, TEMPLATE_MUTATION_MARKER_PATH)); return;
    }
    if (parsed.positional.length !== 1) fail("update requires a template id");
    const id = validateTemplateId(parsed.positional[0]!);
    const className = text(parsed.options, "class");
    const other = ["contract", "naming", "renderer", "path", "from", "expected-source-digest"]
      .some(name => text(parsed.options, name) !== undefined);
    if (className !== undefined) {
      if (other) fail("--class cannot be combined with binding/source updates");
      if (className !== "managed-default" && className !== "registered-existing") fail("--class is invalid");
      await mutate(parsed, { mode: "reclassify", templateId: id, toClass: className }); return;
    }
    if (!other) fail("update requires at least one of --contract, --naming, --renderer, --path, or --class");
    const resolved = await target(parsed.options); ensureMutableTarget(resolved);
    const current = await policy(resolved.vault);
    const previous = current.templates[id];
    if (previous === undefined) {
      const sourcePath = text(parsed.options, "path");
      const from = text(parsed.options, "from");
      const expectedSourceDigestText = text(parsed.options, "expected-source-digest");
      const requestedRenderer = renderer(text(parsed.options, "renderer"));
      if (
        sourcePath === undefined
        || from === undefined
        || expectedSourceDigestText === undefined
        || !DIGEST.test(expectedSourceDigestText)
        || requestedRenderer === undefined
        || text(parsed.options, "contract") !== undefined
        || text(parsed.options, "naming") !== undefined
      ) fail("pending source update requires --path, --from, --expected-source-digest, and --renderer only");
      const expectedSourceDigest = requiredDigest(parsed.options, "expected-source-digest");
      print(await repairPendingTemplateSource(resolved, {
        templateId: id,
        sourcePath,
        expectedSourceDigest,
        renderer: requestedRenderer,
        bytes: await boundedFile(from),
      }, guard(parsed.options)));
      return;
    }
    if (text(parsed.options, "from") !== undefined || text(parsed.options, "expected-source-digest") !== undefined) {
      fail("--from and --expected-source-digest are only valid for a pending source update");
    }
    const sourcePath = normalizeTemplateSourcePath(text(parsed.options, "path") ?? deriveTemplateSourcePath(previous));
    const bytes = await boundedFile(path.join(resolved.vault, sourcePath));
    const classified = classifyTemplateRenderer(sourcePath, bytes);
    const nextRenderer = renderer(text(parsed.options, "renderer")) ?? previous.renderer;
    if (nextRenderer !== classified.renderer) throw new Error(`TEMPLATE_SOURCE_INVALID: renderer ${nextRenderer} does not match observed renderer ${classified.renderer}`);
    const binding: TemplateBinding = { ...previous, renderer: nextRenderer, sourcePath, contract: knownContract(current, text(parsed.options, "contract") ?? previous.contract), naming: text(parsed.options, "naming") ?? previous.naming };
    const change: TemplateSemanticChange = { mode: "update", templateId: id, binding, source: { path: sourcePath, bytes, publication: "verify-existing" }, ...(sourcePath === deriveTemplateSourcePath(previous) ? {} : { moveStrategy: "register-already-moved" as const }) };
    print(await executeTemplateOperation(resolved, change, guard(parsed.options))); return;
  }
  if (parsed.verb === "move") {
    only(parsed, ["vault", "dry-run", "yes", "approved-digest", "folder"], 0);
    const folder = text(parsed.options, "folder"); if (folder === undefined) fail("move requires --folder");
    await mutate(parsed, { mode: "relocate-folder", templateFolder: normalizeTemplateFolderPath(folder) }); return;
  }
  if (parsed.verb === "remove") {
    only(parsed, ["vault", "dry-run", "yes", "approved-digest", "delete-source"], 1);
    await mutate(parsed, { mode: "remove", templateId: validateTemplateId(parsed.positional[0]!), deleteSource: flag(parsed.options, "delete-source") }); return;
  }
  if (parsed.verb === "default") {
    only(parsed, ["vault", "dry-run", "yes", "approved-digest"], 1);
    await mutate(parsed, { mode: "default", templateId: validateTemplateId(parsed.positional[0]!) }); return;
  }
  fail(`unknown template verb ${parsed.verb}`);
}

export function templateUsage(): string {
  return `Usage: oms template <verb> [options]

Leaves: scan | list | show | add | update | move | remove | default | check | regenerate-types | review | answer | commit

Read-only:
  list
  show <id>
  scan
  check
  review [--template-id <id>] [--vault <vault>]

Contract review:
  answer <question-id> [--template-id <id>] --answer <JSON> --census-digest <digest> --ledger-digest <digest|null> [--vault <vault>]
  commit [--template-id <id>] --census-digest <digest> --ledger-digest <digest|null> (--dry-run | --yes --approved-digest <digest>) [--vault <vault>]

Guarded template operations (use --dry-run, then --yes --approved-digest <digest>):
  add <folder> [--creation-default]
  add --id <id> --from <content.md> [--folder <folder>] [--contract <name>] [--naming <pattern>]
  update <id> [--contract <name>] [--naming <pattern>] [--path <file>] [--renderer <renderer>]
  update <pending-id> --path <existing-file> --from <content.md> --expected-source-digest <digest> --renderer <renderer>
  update <id> --class managed-default|registered-existing
  update --resume <transaction-id> --yes --approved-digest <digest>
  move --folder <registered-folder>
  remove <id> [--delete-source]
  default <id>
  regenerate-types`;
}

export async function runTemplateCommand(argv: readonly string[]): Promise<void> {
  process.exitCode = 0;
  try {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) { console.log(templateUsage()); return; }
    const parsed = parse(argv);
    if (flag(parsed.options, "help")) { console.log(templateUsage()); return; }
    await run(parsed);
  } catch (error: unknown) {
    process.exitCode = 1;
    print({ status: "rejected", diagnostics: [{ code: error instanceof Error ? error.message.split(":", 1)[0] : "TEMPLATE_COMMAND_FAILED", remediation: error instanceof Error ? error.message : String(error) }] });
  }
}
