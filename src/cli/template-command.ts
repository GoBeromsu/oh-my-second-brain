import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { resolveEffectiveVault } from "../kernel/link/link.js";
import { summarizeRuntimeHistory } from "../kernel/runtime/event-summary.js";
import { composeTemplateAdd } from "../kernel/templates/compose-add.js";
import { diagnoseTemplates, regenerateTypes } from "../kernel/templates/doctor.js";
import { planTemplateMigration } from "../kernel/templates/migration.js";
import { executeTemplateOperation } from "../kernel/templates/operations.js";
import { deriveTemplateSourcePath, isTemplateSourceInFolder, normalizeTemplateFolderPath, normalizeTemplateSourcePath, validateTemplateId } from "../kernel/templates/paths.js";
import { parseTemplatePolicy } from "../kernel/templates/policy.js";
import { registerExistingTemplate } from "../kernel/templates/register.js";
import { classifyTemplateRenderer } from "../kernel/templates/renderer.js";
import { loadResolvedTemplates } from "../kernel/templates/resolver.js";
import { resumeTemplateTransaction, TEMPLATE_MUTATION_MARKER_PATH } from "../kernel/templates/transaction.js";
import type { Digest, GuardedTemplateRequest, TemplateBinding, TemplatePolicy, TemplateRenderer, TemplateSemanticChange } from "../kernel/templates/types.js";
import type { WriteTargetSource } from "../kernel/conventions/write-protocol.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_SOURCE_BYTES = 262_144;
const DEFAULT_NAMING = "{{date}}-{{slug}}.md";

type Options = Record<string, string | boolean>;
interface Parsed { readonly verb: string; readonly positional: readonly string[]; readonly options: Options; }
interface Target { readonly vault: string; readonly source: WriteTargetSource; }

const VALUE_FLAGS = new Set(["vault", "approved-digest", "mode", "id", "contract", "naming", "renderer", "folder", "from", "path", "class", "resume"]);
const BOOLEAN_FLAGS = new Set(["dry-run", "yes", "creation-default", "delete-source", "help"]);

function fail(message: string): never { throw new Error(`TEMPLATE_ARGS_INVALID: ${message}`); }
function parse(argv: readonly string[]): Parsed {
  if (argv.length === 0) fail("missing template verb");
  const verb = argv[0]!;
  const positional: string[] = [];
  const options: Options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) { positional.push(token); continue; }
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
    if (status === "rejected" || status === "inconsistent" || status === "needs-repair") process.exitCode = 1;
  }
  console.log(JSON.stringify(value, null, 2));
}
function summarizedScan(proposal: Awaited<ReturnType<typeof planTemplateMigration>>): unknown {
  return {
    templateFolders: proposal.templateFolders,
    candidates: proposal.candidates.map(candidate => ({ templateId: candidate.templateId, sourcePath: candidate.sourcePath, renderer: candidate.renderer, filledBy: candidate.filledBy, bodyExternal: candidate.bodyExternal, selected: proposal.bindings.some(binding => binding.templateId === candidate.templateId && binding.sourcePath === candidate.sourcePath), samples: candidate.contractFromNotes?.samples ?? 0, coverage: candidate.contractFromNotes?.coverage ?? {}, diagnostics: [...candidate.rendererDiagnostics, ...(candidate.contractFromNotes?.diagnostics ?? [])] })),
    diagnostics: proposal.diagnostics,
    unresolved: proposal.unresolved,
    inputDigest: proposal.inputDigest,
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
    print(summarizedScan(await planTemplateMigration(resolved.vault))); return;
  }
  if (parsed.verb === "check") {
    only(parsed, ["vault"], 0);
    print(await diagnoseTemplates(await target(parsed.options))); return;
  }
  if (parsed.verb === "regenerate-types") {
    only(parsed, ["vault", "dry-run", "yes", "approved-digest"], 0);
    const resolved = await target(parsed.options); ensureMutableTarget(resolved);
    print(await regenerateTypes({ target: resolved, request: guard(parsed.options) })); return;
  }
  if (parsed.verb === "add") {
    only(parsed, ["vault", "dry-run", "yes", "approved-digest", "mode", "creation-default", "id", "contract", "naming", "renderer", "folder", "from"], [0, 1]);
    const resolved = await target(parsed.options); ensureMutableTarget(resolved);
    const request = guard(parsed.options);
    const idText = text(parsed.options, "id");
    const from = text(parsed.options, "from");
    if (idText === undefined && from === undefined) {
      if (parsed.positional.length !== 1) fail("add <folder> requires one folder");
      const mode = text(parsed.options, "mode") ?? "manual";
      if (mode !== "auto" && mode !== "manual") fail("--mode must be auto or manual");
      if (text(parsed.options, "contract") !== undefined || text(parsed.options, "naming") !== undefined || text(parsed.options, "renderer") !== undefined || text(parsed.options, "folder") !== undefined) fail("folder registration does not accept template binding flags");
      print(await executeTemplateOperation(resolved, { mode: "register-folder", folder: { path: normalizeTemplateFolderPath(parsed.positional[0]!), mode, ...(flag(parsed.options, "creation-default") ? { default: true as const } : {}) } }, request)); return;
    }
    if (idText === undefined) fail("template add requires --id");
    const id = validateTemplateId(idText);
    const current = await policy(resolved.vault);
    const contract = knownContract(current, text(parsed.options, "contract"));
    const naming = text(parsed.options, "naming") ?? DEFAULT_NAMING;
    if (from !== undefined) {
      if (parsed.positional.length !== 0 || text(parsed.options, "renderer") !== undefined || flag(parsed.options, "creation-default") || text(parsed.options, "mode") !== undefined) fail("add --from conflicts with a positional source and folder registration flags");
      const composed = composeTemplateAdd(current.templateFolders, { templateId: id, sourceFolder: text(parsed.options, "folder"), bytes: await boundedFile(from), contract, naming });
      print(await executeTemplateOperation(resolved, { mode: "create", binding: composed.binding, source: composed.source }, request)); return;
    }
    if (parsed.positional.length !== 1 || flag(parsed.options, "creation-default") || text(parsed.options, "mode") !== undefined) fail("add <existing-file> --id requires exactly one source file");
    const sourcePath = normalizeTemplateSourcePath(parsed.positional[0]!);
    const bytes = await boundedFile(path.join(resolved.vault, sourcePath));
    const classified = classifyTemplateRenderer(sourcePath, bytes);
    const requestedRenderer = renderer(text(parsed.options, "renderer")) ?? classified.renderer;
    if (requestedRenderer !== classified.renderer) throw new Error(`TEMPLATE_SOURCE_INVALID: requested renderer ${requestedRenderer} does not match observed renderer ${classified.renderer}`);
    const explicitFolder = text(parsed.options, "folder");
    const sourceFolder = explicitFolder === undefined
      ? [...current.templateFolders].sort((a, b) => b.path.length - a.path.length).find(folder => isTemplateSourceInFolder(sourcePath, folder.path))?.path
      : normalizeTemplateFolderPath(explicitFolder);
    if (sourceFolder === undefined) throw new Error("TEMPLATE_SOURCE_INVALID: source is outside registered template folders; pass --folder after registering it");
    print(await registerExistingTemplate(resolved.vault, { templateId: id, sourceFolder, sourcePath, renderer: requestedRenderer, filledBy: classified.filledBy, contract, naming }, request)); return;
  }
  if (parsed.verb === "update") {
    only(parsed, ["vault", "dry-run", "yes", "approved-digest", "contract", "naming", "renderer", "path", "class", "resume"], [0, 1]);
    const resume = text(parsed.options, "resume");
    if (resume !== undefined) {
      if (parsed.positional.length !== 0 || ["contract", "naming", "renderer", "path", "class"].some(name => text(parsed.options, name) !== undefined)) fail("--resume conflicts with update fields and template id");
      const resolved = await target(parsed.options); ensureMutableTarget(resolved);
      const request = guard(parsed.options);
      if (request.approvedDigest === undefined) fail("--resume requires approved apply, not --dry-run");
      print(await resumeTemplateTransaction(resolved.vault, resume, request.approvedDigest, TEMPLATE_MUTATION_MARKER_PATH)); return;
    }
    if (parsed.positional.length !== 1) fail("update requires a template id");
    const id = validateTemplateId(parsed.positional[0]!);
    const className = text(parsed.options, "class");
    const other = ["contract", "naming", "renderer", "path"].some(name => text(parsed.options, name) !== undefined);
    if (className !== undefined) {
      if (other) fail("--class cannot be combined with binding/source updates");
      if (className !== "managed-default" && className !== "registered-existing") fail("--class is invalid");
      await mutate(parsed, { mode: "reclassify", templateId: id, toClass: className }); return;
    }
    if (!other) fail("update requires at least one of --contract, --naming, --renderer, --path, or --class");
    const resolved = await target(parsed.options); ensureMutableTarget(resolved);
    const current = await policy(resolved.vault);
    const previous = current.templates[id];
    if (previous === undefined) throw new Error(`TEMPLATE_NOT_FOUND: ${id}`);
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
  return `Usage: oms template <verb> [options]\n\nRead-only:\n  list | show <id> | scan | check\nMutations (use --dry-run, then --yes --approved-digest <digest>):\n  add <folder> [--mode auto|manual] [--creation-default]\n  add <existing-file> --id <id> [--folder <folder>] [--contract <name>] [--naming <pattern>] [--renderer <renderer>]\n  add --id <id> --from <content.md> [--folder <folder>] [--contract <name>] [--naming <pattern>]\n  update <id> [--contract <name>] [--naming <pattern>] [--path <file>] [--renderer <renderer>]\n  update <id> --class managed-default|registered-existing\n  update --resume <transaction-id> --yes --approved-digest <digest>\n  move --folder <registered-folder>\n  remove <id> [--delete-source]\n  default <id>\n  regenerate-types`;
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
