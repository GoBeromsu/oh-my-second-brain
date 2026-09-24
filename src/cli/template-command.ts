import path from "node:path";
import { readFile } from "node:fs/promises";

import type { WriteTargetSource } from "../kernel/conventions/write-protocol.js";
import { resolveEffectiveVault } from "../kernel/link/link.js";
import { summarizeRuntimeHistory } from "../kernel/runtime/event-summary.js";
import { composeContractV5, parseContractPolicyV5 } from "../kernel/templates/contract-v5.js";
import { discoverRegisteredSources } from "../kernel/templates/source-registry.js";
import { readVaultSettings } from "../kernel/templates/vault-settings.js";
import { acknowledgeContractSource, diagnoseContract, publishContract, relinkContractSource, reviewContractSources } from "../kernel/templates/service.js";
import { validateTemplateId } from "../kernel/templates/paths.js";


type Options = Record<string, string | boolean>;
interface Parsed { readonly verb: string; readonly positional: readonly string[]; readonly options: Options; }
type Target = { readonly vault: string; readonly source: WriteTargetSource };

const VALUE_FLAGS = new Set(["vault", "approved-digest", "answer", "census-digest", "ledger-digest", "proposals", "template-id", "reviewed-digest", "candidate-path", "transaction-id", "policy"]);
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
async function run(parsed: Parsed): Promise<void> {
  if (parsed.verb === "list" || parsed.verb === "show") {
    only(parsed, ["vault"], parsed.verb === "list" ? 0 : 1);
    const resolved = await target(parsed.options);
    const review = await reviewContractSources({ target: resolved });
    const policy = parseContractPolicyV5(await readFile(path.join(resolved.vault, ".oms", "template-policy.json"), "utf8"));
    if (parsed.verb === "list") {
      const common = composeContractV5(policy, null);
      print({
        vault: resolved.vault,
        revision: policy.revision,
        common: policy.common.status === "active"
          ? { status: "active", contractDigest: common.contractDigest, fields: common.fields }
          : { status: "review-required", reasons: policy.common.reasons },
        templates: Object.keys(policy.templates).sort().map(templateId => {
          const entry = policy.templates[templateId]!;
          if (entry.status !== "active") return { templateId, status: entry.status, reasons: entry.reasons };
          return {
            templateId,
            status: "active",
            contractDigest: composeContractV5(policy, templateId).contractDigest,
            source: { identity: entry.source.identity, path: entry.source.path },
            sourceState: review.reviews.find(item => item.templateId === templateId)?.state ?? null,
          };
        }),
        history: summarizeRuntimeHistory({ vaultPath: resolved.vault }),
      });
      return;
    }
    const id = validateTemplateId(parsed.positional[0]!);
    const entry = policy.templates[id];
    if (entry === undefined) throw new Error(`TEMPLATE_NOT_FOUND: ${id}`);
    print(entry.status === "active"
      ? {
        vault: resolved.vault,
        revision: policy.revision,
        templateId: id,
        status: "active",
        contract: composeContractV5(policy, id),
        source: { identity: entry.source.identity, path: entry.source.path, rawDigest: entry.source.rawDigest },
        sourceState: review.reviews.find(item => item.templateId === id)?.state ?? null,
      }
      : { vault: resolved.vault, revision: policy.revision, templateId: id, status: entry.status, reasons: entry.reasons });
    return;
  }
  if (parsed.verb === "scan") {
    only(parsed, ["vault"], 0);
    const resolved = await target(parsed.options);
    const policy = parseContractPolicyV5(await readFile(path.join(resolved.vault, ".oms", "template-policy.json"), "utf8"));
    const settings = await readVaultSettings(resolved.vault);
    const discovery = await discoverRegisteredSources(resolved.vault, policy, settings?.templateRoots ?? []);
    print({ vault: resolved.vault, revision: policy.revision, roots: settings?.templateRoots ?? [], ...discovery });
    return;
  }
  if (parsed.verb === "publish") {
    only(parsed, ["vault", "policy", "transaction-id", "yes"], 0);
    const resolved = await target(parsed.options);
    const raw = text(parsed.options, "policy");
    const transactionId = text(parsed.options, "transaction-id");
    if (raw === undefined || transactionId === undefined) fail("publish requires --policy and --transaction-id");
    let policy: unknown;
    try { policy = JSON.parse(await readFile(path.resolve(raw), "utf8")); }
    catch { fail(`--policy must name a readable JSON contract document: ${raw}`); }
    print(await publishContract({ target: resolved, policy, transactionId, confirmed: flag(parsed.options, "yes") })); return;
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
  if (parsed.verb === "publish") {
    only(parsed, ["vault", "policy", "transaction-id", "yes"], 0);
    const resolved = await target(parsed.options);
    const raw = text(parsed.options, "policy");
    const transactionId = text(parsed.options, "transaction-id");
    if (raw === undefined || transactionId === undefined) fail("publish requires --policy and --transaction-id");
    let policy: unknown;
    try { policy = JSON.parse(await readFile(path.resolve(raw), "utf8")); }
    catch { fail(`--policy must name a readable JSON contract document: ${raw}`); }
    print(await publishContract({ target: resolved, policy, transactionId, confirmed: flag(parsed.options, "yes") })); return;
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
  if (parsed.verb === "check") {
    only(parsed, ["vault"], 0);
    const resolved = await target(parsed.options);
    print(await diagnoseContract({ target: resolved })); return;
  }
  fail(`unknown template verb ${parsed.verb}`);
}

export function templateUsage(): string {
  return `Usage: oms template <verb> [options]

Leaves: list | show | scan | check | publish | review-sources | acknowledge-source | relink-source

Read-only:
  list
  show <id>
  scan
  check
  review-sources [--template-id <id>] [--vault <vault>]

Contract publication (the document is your own contract meaning):
  publish --policy <file.json> --transaction-id <uuid> [--yes] [--vault <vault>]

Source review (the contract rules never change):
  acknowledge-source --template-id <id> --reviewed-digest <digest> --transaction-id <uuid> [--yes] [--vault <vault>]
  relink-source --template-id <id> --candidate-path <path> --transaction-id <uuid> [--yes] [--vault <vault>]

  Without --yes every mutating leaf prints what would be confirmed and changes nothing.
  Contract meaning enters OMS only as the explicit policy document you publish; it
  is never derived from a file name or from template syntax.
`;
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
