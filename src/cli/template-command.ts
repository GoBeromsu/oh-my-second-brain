import path from "node:path";

import { resolveEffectiveVault } from "../kernel/link/link.js";
import { summarizeRuntimeHistory } from "../kernel/runtime/event-summary.js";
import { diagnoseTemplates, regenerateTypes } from "../kernel/templates/doctor.js";
import { nextTemplateInterview, answerTemplateInterview, commitTemplateContracts } from "../kernel/templates/interview-service.js";
import type { TemplateProposalInput } from "../kernel/templates/interview.js";
import type { TemplateOperationTarget } from "../kernel/templates/operations.js";
import { readTemplateReviewContext } from "../kernel/templates/review-context.js";
import { acknowledgeContractSource, relinkContractSource, reviewContractSources } from "../kernel/templates/service.js";
import { validateTemplateId } from "../kernel/templates/paths.js";
import { loadResolvedTemplates } from "../kernel/templates/resolver.js";
import type { Digest, GuardedTemplateRequest, JsonValue } from "../kernel/templates/types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

type Options = Record<string, string | boolean>;
interface Parsed { readonly verb: string; readonly positional: readonly string[]; readonly options: Options; }
type Target = TemplateOperationTarget;

const VALUE_FLAGS = new Set(["vault", "approved-digest", "answer", "census-digest", "ledger-digest", "proposals", "template-id", "reviewed-digest", "candidate-path", "transaction-id"]);
const BOOLEAN_FLAGS = new Set(["dry-run", "yes", "help"]);

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
/**
 * Explicit contract proposals, as JSON. OMS never derives contract meaning by
 * reading template syntax, so a proposal is the only way to introduce one.
 */
function proposalsOption(options: Options): { readonly proposals?: readonly TemplateProposalInput[] } {
  const raw = text(options, "proposals");
  if (raw === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("--proposals must be valid JSON");
  }
  if (!Array.isArray(value) || !value.every(jsonValue)) fail("--proposals must be a JSON array of proposals");
  return { proposals: value as unknown as readonly TemplateProposalInput[] };
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
  return {
    generationDigest: context.resolved.generationDigest,
    // Approved Markdown is reported by digest; raw source bytes are identified,
    // never parsed for meaning.
    approved: context.approved.map(entry => ({
      templateId: entry.templateId,
      templatePath: entry.templatePath,
      approvedMarkdownDigest: entry.approvedMarkdownDigest,
    })),
    raw: context.raw,
    drafts: context.resolved.drafts,
    diagnostics: context.resolved.diagnostics,
  };
}

async function run(parsed: Parsed): Promise<void> {
  if (parsed.verb === "list" || parsed.verb === "show") {
    only(parsed, ["vault"], parsed.verb === "list" ? 0 : 1);
    const resolved = await target(parsed.options);
    const convention = await loadResolvedTemplates(resolved.vault);
    if (parsed.verb === "list") {
      print({
        // The always-on default layer applies to every note, so it is listed
        // beside the optional individual templates.
        default: convention.defaultContract,
        templates: Object.values(convention.templates),
        generationDigest: convention.generationDigest,
        history: summarizeRuntimeHistory({ vaultPath: resolved.vault }),
      });
      return;
    }
    const id = validateTemplateId(parsed.positional[0]!);
    const found = convention.templates[id];
    if (found === undefined) throw new Error(`TEMPLATE_NOT_FOUND: ${id}`);
    print({ template: found, generationDigest: convention.generationDigest }); return;
  }
  if (parsed.verb === "scan") {
    only(parsed, ["vault"], 0);
    const resolved = await target(parsed.options);
    print(summarizedScan(await readTemplateReviewContext(resolved.vault))); return;
  }
  if (parsed.verb === "review-sources") {
    only(parsed, ["vault", "template-id"], 0);
    const resolved = await target(parsed.options);
    const templateId = text(parsed.options, "template-id");
    print(await reviewContractSources({ target: resolved, ...(templateId === undefined ? {} : { templateId }) })); return;
  }
  if (parsed.verb === "acknowledge-source" || parsed.verb === "relink-source") {
    only(parsed, ["vault", "template-id", "reviewed-digest", "candidate-path", "transaction-id", "yes"], 0);
    const resolved = await target(parsed.options);
    const templateId = text(parsed.options, "template-id");
    const transactionId = text(parsed.options, "transaction-id");
    if (templateId === undefined || transactionId === undefined) fail(`${parsed.verb} requires --template-id and --transaction-id`);
    const confirmed = flag(parsed.options, "yes");
    if (parsed.verb === "acknowledge-source") {
      const reviewedDigest = text(parsed.options, "reviewed-digest");
      if (reviewedDigest === undefined) fail("acknowledge-source requires the --reviewed-digest observed during review");
      print(await acknowledgeContractSource({ target: resolved, templateId, reviewedDigest, transactionId, confirmed })); return;
    }
    const candidatePath = text(parsed.options, "candidate-path");
    if (candidatePath === undefined) fail("relink-source requires an explicit --candidate-path");
    print(await relinkContractSource({ target: resolved, templateId, candidatePath, transactionId, confirmed })); return;
  }
  if (parsed.verb === "review") {
    only(parsed, ["vault", "proposals"], 0);
    const resolved = await target(parsed.options);
    print(await nextTemplateInterview(resolved, proposalsOption(parsed.options))); return;
  }
  if (parsed.verb === "answer") {
    only(parsed, ["vault", "answer", "census-digest", "ledger-digest", "proposals"], 1);
    const resolved = await target(parsed.options);
    ensureMutableTarget(resolved);
    const questionId = parsed.positional[0]!;
    if (!DIGEST.test(questionId)) fail("answer requires a sha256:<64hex> question id");
    print(await answerTemplateInterview(resolved, {
      questionId: questionId as Digest,
      answer: answerValue(parsed.options),
      censusDigest: requiredDigest(parsed.options, "census-digest"),
      expectedLedgerDigest: expectedLedgerDigest(parsed.options),
      ...proposalsOption(parsed.options),
    })); return;
  }
  if (parsed.verb === "commit") {
    only(parsed, ["vault", "census-digest", "ledger-digest", "dry-run", "yes", "approved-digest", "proposals"], 0);
    const resolved = await target(parsed.options);
    ensureMutableTarget(resolved);
    // Commit rebuilds the interview, so it needs the same proposals that raised
    // the answered questions; without them a recorded decision cannot be
    // reproduced and publication is refused.
    print(await commitTemplateContracts(resolved, {
      censusDigest: requiredDigest(parsed.options, "census-digest"),
      expectedLedgerDigest: expectedLedgerDigest(parsed.options),
      ...proposalsOption(parsed.options),
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
  fail(`unknown template verb ${parsed.verb}`);
}

export function templateUsage(): string {
  return `Usage: oms template <verb> [options]

Leaves: scan | list | show | check | regenerate-types | review-sources | acknowledge-source | relink-source | review | answer | commit

Read-only:
  list
  show <id>
  scan
  check
  review-sources [--template-id <id>] [--vault <vault>]
  review [--proposals <JSON>] [--vault <vault>]

Source review (the contract rules never change):
  acknowledge-source --template-id <id> --reviewed-digest <digest> --transaction-id <uuid> [--yes] [--vault <vault>]
  relink-source --template-id <id> --candidate-path <path> --transaction-id <uuid> [--yes] [--vault <vault>]

  Without --yes both print the review that would be confirmed and change nothing.

Contract review:
  answer <question-id> --answer <JSON> --census-digest <digest> --ledger-digest <digest|null> [--proposals <JSON>] [--vault <vault>]
  commit --census-digest <digest> --ledger-digest <digest|null> [--proposals <JSON>] (--dry-run | --yes --approved-digest <digest>) [--vault <vault>]

  --proposals carries the explicit contract proposals as a JSON array. Contract
  meaning enters OMS only this way; it is never derived from a file name or from
  template syntax. Pass the same proposals to review, answer, and commit, or a
  recorded answer cannot be reproduced and publication is refused.

Guarded:
  regenerate-types (--dry-run | --yes --approved-digest <digest>) [--vault <vault>]`;
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
