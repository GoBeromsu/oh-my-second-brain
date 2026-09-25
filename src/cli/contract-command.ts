import path from "node:path";
import { createInterface } from "node:readline/promises";

import { extractTemplate } from "../kernel/contract/extract.js";
import { InterviewAborted, runInterview, type InterviewIO, type Question } from "../kernel/contract/interview.js";
import { contractDoctor, contractStatus, doctorFix, ROW_FINDING } from "../kernel/contract/status.js";
import { resolveEffectiveVault } from "../kernel/link/link.js";
import { VaultSettingsError } from "../kernel/vault/settings.js";

export function contractUsage(): string {
  return `Usage: oms contract <setup|extract|status|doctor> [options]

  setup [--reask] [--vault <path>]
            Interview the whole vault (folders, properties, templates) and seal the contract.
            --reask asks again about items declined at an earlier seal.
  extract --template <path> [--vault <path>]
            Show what a template declares. <path> is relative to the vault. Values are not printed.
  status [--vault <path>]
            Show the contract posture and template drift. Hidden values are never printed.
  doctor [--fix] [--vault <path>]
            Diagnose the seal. --fix only re-indexes a moved or unindexed vault.

setup is interactive and needs a terminal; it is never run by an agent.`;
}

const VERBS = ["setup", "extract", "status", "doctor"] as const;
type Verb = (typeof VERBS)[number];

interface ContractArgs {
  readonly verb: Verb;
  readonly vault?: string;
  readonly template?: string;
  readonly fix: boolean;
  readonly reask: boolean;
}

function parse(argv: readonly string[]): ContractArgs {
  const [verb, ...rest] = argv;
  if (verb === undefined) throw new Error("CONTRACT_ARGS_INVALID: missing subcommand (setup, extract, status, or doctor)");
  if (!(VERBS as readonly string[]).includes(verb)) throw new Error(`CONTRACT_ARGS_INVALID: unknown subcommand ${verb}`);
  let vault: string | undefined;
  let template: string | undefined;
  let fix = false;
  let reask = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === "--fix" && verb === "doctor") {
      if (fix) throw new Error("CONTRACT_ARGS_INVALID: duplicate flag --fix");
      fix = true;
      continue;
    }
    if (token === "--reask" && verb === "setup") {
      if (reask) throw new Error("CONTRACT_ARGS_INVALID: duplicate flag --reask");
      reask = true;
      continue;
    }
    if (token !== "--vault" && !(token === "--template" && verb === "extract")) {
      throw new Error(`CONTRACT_ARGS_INVALID: unknown argument ${token}`);
    }
    const value = rest[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`CONTRACT_ARGS_INVALID: ${token} requires a value`);
    if (token === "--vault") {
      if (vault !== undefined) throw new Error("CONTRACT_ARGS_INVALID: duplicate flag --vault");
      vault = value;
    } else {
      if (template !== undefined) throw new Error("CONTRACT_ARGS_INVALID: duplicate flag --template");
      template = value;
    }
  }
  if (verb === "extract" && template === undefined) throw new Error("CONTRACT_ARGS_INVALID: extract needs --template <path>");
  return { verb: verb as Verb, fix, reask, ...(vault === undefined ? {} : { vault }), ...(template === undefined ? {} : { template }) };
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function templatePath(vault: string, template: string): string {
  const relative = path.isAbsolute(template) ? path.relative(vault, template) : path.normalize(template);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("CONTRACT_ARGS_INVALID: --template must name a file inside the vault");
  }
  return relative.split(path.sep).join("/");
}

function describe(question: Question): string {
  if (question.kind === "choice") {
    const options = question.options.map((option, index) => `  ${index + 1}) ${option}`).join("\n");
    return `${question.prompt}\n${options}\n> `;
  }
  if (question.kind === "confirm") {
    const hint = question.initial === true ? "[Y/n]" : question.initial === false ? "[y/N]" : "[y/n]";
    return `${question.prompt} ${hint} `;
  }
  return question.initial === undefined || question.initial === "" ? `${question.prompt}\n> ` : `${question.prompt}\n  [${question.initial}]\n> `;
}

/** Terminal IO for the interview. Closing the input (Ctrl-D / Ctrl-C) aborts without sealing. */
function terminalIO(): { readonly io: InterviewIO; close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => { closed = true; });
  const io: InterviewIO = {
    say: line => { console.log(line); },
    ask: async question => {
      if (closed) throw new InterviewAborted();
      let onClose = (): void => {};
      const aborted = new Promise<never>((_, reject) => {
        onClose = () => reject(new InterviewAborted());
        rl.once("close", onClose);
      });
      try {
        return (await Promise.race([rl.question(describe(question)), aborted])).trim();
      } finally {
        rl.off("close", onClose);
      }
    },
  };
  return { io, close: () => rl.close() };
}

async function setup(vault: string, reask: boolean, deps: ContractCommandDeps): Promise<void> {
  const interactive = deps.interactive ?? (process.stdin.isTTY === true && process.env["OMS_NON_INTERACTIVE"] !== "1");
  if (deps.io === undefined && !interactive) {
    process.exitCode = 1;
    console.error("[oms] contract setup needs an interactive terminal. Run it yourself in a terminal; it is never run by an agent or a script.");
    return;
  }
  const terminal = deps.io === undefined ? terminalIO() : null;
  try {
    const result = await runInterview({ vault, io: deps.io ?? terminal!.io, ...(reask ? { reask } : {}) });
    if (result.state !== "sealed") process.exitCode = 1;
    if (result.state === "sealed") {
      print({
        status: "sealed",
        vaultIdCreated: result.vaultIdCreated,
        folders: result.folders,
        properties: result.properties,
        templates: result.templates,
        ...(result.removedTemplates === undefined || result.removedTemplates.length === 0 ? {} : { removedTemplates: result.removedTemplates }),
      });
    } else if (result.state === "refused") {
      print({ status: "refused", reasons: result.reasons });
    } else {
      print({ status: "aborted", remediation: "Nothing was sealed." });
    }
  } finally {
    terminal?.close();
  }
}

/** Shapes only: literal values stay out of the output so an agent running this learns no rule. */
async function extract(vault: string, template: string): Promise<void> {
  const result = await extractTemplate(vault, templatePath(vault, template));
  if (!result.ok) {
    process.exitCode = 1;
    print({ status: "rejected", diagnostics: result.diagnostics.map(item => ({ code: item.code })) });
    return;
  }
  print({
    status: "extracted",
    fields: result.extraction.fields.map(field => ({
      name: field.name,
      type: field.inferredType,
      variable: field.variable,
      literal: field.literal !== null,
    })),
    headings: result.extraction.headings,
  });
}

async function doctor(vault: string, fix: boolean): Promise<void> {
  if (fix) {
    const result = await doctorFix(vault);
    if (result === "not-fixable") process.exitCode = 1;
    print({ status: result });
    return;
  }
  const report = await contractDoctor(vault, "human");
  // Healthy rows carry only their own row finding; any added finding (shared id, unreadable settings or store) needs attention.
  const healthy = (report.row === "sealed" || report.row === "never-sealed")
    && report.findings.every(finding => finding === ROW_FINDING[report.row]) && report.cause === null
    && report.staleLocks === 0 && report.orphans === 0 && report.unexpectedControlFiles.length === 0;
  if (!healthy) process.exitCode = 1;
  print({
    contract: report.contract,
    findings: report.findings,
    cause: report.cause,
    recovery: report.recovery,
    staleLocks: report.staleLocks,
    orphans: report.orphans,
    unexpectedControlFiles: report.unexpectedControlFiles,
    transportFailures: report.transportFailures,
  });
}

export interface ContractCommandDeps {
  /** Scripted IO for tests; when given, the terminal check is skipped. */
  readonly io?: InterviewIO;
  readonly interactive?: boolean;
}

export async function runContractCommand(argv: readonly string[], deps: ContractCommandDeps = {}): Promise<void> {
  process.exitCode = 0;
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(contractUsage());
    if (argv.length === 0) process.exitCode = 1;
    return;
  }
  try {
    const args = parse(argv);
    let target: { readonly vault: string; readonly source: string };
    try {
      target = args.vault === undefined
        ? await resolveEffectiveVault(process.cwd(), process.env)
        : { vault: path.resolve(args.vault), source: "explicit" };
    } catch {
      // Resolution messages name bridge and vault paths; only the fixed code is reported.
      throw new Error("CONTRACT_VAULT_UNRESOLVED: the vault could not be resolved. Pass --vault <path> or run: oms status");
    }
    const writes = args.verb === "setup" || args.verb === "doctor" && args.fix;
    if (writes && target.source === "cwd") {
      throw new Error(`CONTRACT_ARGS_INVALID: contract ${args.verb} writes and requires --vault or an existing verified vault/bridge/env target`);
    }
    const vault = target.vault;
    if (args.verb === "setup") await setup(vault, args.reask, deps);
    else if (args.verb === "extract") await extract(vault, args.template!);
    else if (args.verb === "status") {
      const status = await contractStatus(vault);
      print({ contract: status.contract, findings: status.findings, templates: status.templates });
    } else await doctor(vault, args.fix);
  } catch (error: unknown) {
    process.exitCode = 1;
    print({ status: "rejected", diagnostics: [commandDiagnostic(error)] });
  }
}

/** Filesystem causes by errno. The error's own message is never echoed: it can name the store path. */
const FS_REMEDIATION: Readonly<Record<string, string>> = {
  EACCES: "Permission denied on the vault or the contract store. Check their ownership and permissions, then retry.",
  EPERM: "The operation is not permitted on the vault or the contract store. Check their ownership and permissions, then retry.",
  ENOSPC: "No space left on the device. Free disk space, then retry.",
  EROFS: "The vault or the contract store is on a read-only filesystem.",
  ENOENT: "A file disappeared while the command ran. Retry, then run: oms contract doctor",
  ELOOP: "A symlink loop was found. Run: oms contract doctor",
};

/**
 * Coded, path-free diagnostics. Messages we author (`CONTRACT_`, vault settings,
 * unsafe template source) carry field names only and pass through.
 */
export function commandDiagnostic(error: unknown): { readonly code: string; readonly remediation: string } {
  if (error instanceof VaultSettingsError) return { code: error.code, remediation: error.message };
  if (error instanceof Error && /^(CONTRACT_[A-Z_]+|TEMPLATE_SOURCE_UNSAFE):/.test(error.message)) {
    return { code: error.message.split(":", 1)[0]!, remediation: error.message };
  }
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof errno === "string" && /^E[A-Z]+$/.test(errno)) {
    return { code: "CONTRACT_FS_ERROR", remediation: `${errno}: ${FS_REMEDIATION[errno] ?? "A filesystem operation failed. Run: oms contract doctor"}` };
  }
  return { code: "CONTRACT_COMMAND_FAILED", remediation: "The contract command failed. Run: oms contract doctor" };
}
