import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { resumableIO } from "../kernel/contract/interview-resume.js";
import { InterviewAborted, runInterview, type InterviewIO, type InterviewResult, type Question } from "../kernel/contract/interview.js";
import { parseAnswers, publicQuestion, scriptedIO, type Answers } from "../kernel/contract/scripted-interview.js";
import { StateDirUnsafe } from "../kernel/contract/state-dir.js";
import { storeRoot, type SealDeps } from "../kernel/contract/store.js";
import { gapsReport } from "../kernel/contract/gaps-report.js";
import { lineageNeedsAttention } from "../kernel/contract/lineage-health.js";
import { contractDoctor, contractStatus, doctorFix, ROW_FINDING } from "../kernel/contract/status.js";
import { resolveEffectiveVault } from "../kernel/link/link.js";
import { loadLiveTemplates, selectTemplate } from "../kernel/write/live-templates.js";
import { VaultSettingsError } from "../kernel/vault/settings.js";

export function contractUsage(): string {
  return `Usage: the sealed contract is set up with oms setup and diagnosed with oms doctor.

  oms setup [--reask] [--vault <path>]
            Interview the whole vault (folders and properties) and seal the contract.
            Templates are not sealed: those in templateFolder scaffold new notes.
            --reask asks again about items declined at an earlier seal.
  oms setup --questions [--reask] [--vault <path>]
            Print the interview questions as JSON. Seals nothing.
  oms setup --answers <file|-> [--reask] [--vault <path>]
            Run the same interview from a JSON object of answers by question id (- reads stdin)
            and seal. Missing answers are listed; an invalid or unknown answer seals nothing.
  oms setup extract --template <name> [--vault <path>]
            Preview what a template in templateFolder scaffolds: its keys and headings.
  oms setup status [--vault <path>]
            Show the contract posture. Hidden values are never printed.
  oms doctor contract [--fix] [--vault <path>]
            Diagnose the seal. --fix only re-indexes a moved or unindexed vault.

setup in a terminal has full authority, including loosening a sealed contract.
--questions and --answers let an agent ask the owner each question (the setup skill):
they seal a first contract or a stricter one, never a looser one. Loosening, and any
seal that needs recovery first, is left to \`oms setup\` run by the owner in a terminal.`;
}

const VERBS = ["setup", "extract", "status", "doctor", "gaps"] as const;
type Verb = (typeof VERBS)[number];

interface ContractArgs {
  readonly verb: Verb;
  readonly vault?: string;
  readonly template?: string;
  readonly fix: boolean;
  readonly reask: boolean;
  readonly questions: boolean;
  readonly answers?: string;
}

function parse(argv: readonly string[]): ContractArgs {
  const [verb, ...rest] = argv;
  if (verb === undefined) throw new Error("CONTRACT_ARGS_INVALID: missing subcommand (setup, extract, status, doctor, or gaps)");
  if (!(VERBS as readonly string[]).includes(verb)) throw new Error(`CONTRACT_ARGS_INVALID: unknown subcommand ${verb}`);
  let vault: string | undefined;
  let template: string | undefined;
  let fix = false;
  let reask = false;
  let questions = false;
  let answers: string | undefined;
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
    if (token === "--questions" && verb === "setup") {
      if (questions) throw new Error("CONTRACT_ARGS_INVALID: duplicate flag --questions");
      questions = true;
      continue;
    }
    if (token === "--answers" && verb === "setup") {
      if (answers !== undefined) throw new Error("CONTRACT_ARGS_INVALID: duplicate flag --answers");
      const value = rest[++index];
      if (value === undefined || value.startsWith("--")) throw new Error("CONTRACT_ARGS_INVALID: --answers requires a file or -");
      answers = value;
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
  if (verb === "extract" && template === undefined) throw new Error("CONTRACT_ARGS_INVALID: extract needs --template <name>");
  if (questions && answers !== undefined) throw new Error("CONTRACT_ARGS_INVALID: use --questions or --answers, not both");
  return {
    verb: verb as Verb,
    fix,
    reask,
    questions,
    ...(answers === undefined ? {} : { answers }),
    ...(vault === undefined ? {} : { vault }),
    ...(template === undefined ? {} : { template }),
  };
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
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

function printResult(result: InterviewResult, notes: readonly string[] = []): void {
  if (result.state !== "sealed") process.exitCode = 1;
  if (result.state === "sealed") {
    print({
      status: "sealed",
      vaultIdCreated: result.vaultIdCreated,
      folders: result.folders,
      properties: result.properties,
      ...(result.warnings === undefined || result.warnings.length === 0 ? {} : { warnings: result.warnings }),
    });
  } else if (result.state === "refused") {
    print({ status: "refused", reasons: result.reasons });
  } else if (result.state === "incomplete") {
    print({ status: "incomplete", questions: result.questions.map(publicQuestion), notes, remediation: "Nothing was sealed. Answer these questions too, then run --answers again." });
  } else if (result.state === "loosening") {
    print({
      status: "loosening",
      changes: result.changes,
      remediation: "Nothing was sealed. These answers would loosen the sealed contract; only the owner can do that, by running `oms setup` themselves in a terminal.",
    });
  } else {
    print({ status: "aborted", remediation: "Nothing was sealed." });
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Answers carry hidden rule values, so the file must not sit inside the vault where notes are indexed and synced. */
async function readOutsideVault(vault: string, source: string): Promise<string> {
  if (source === "-") return readStdin();
  let file: string;
  try {
    file = await realpath(path.resolve(source));
  } catch {
    throw new Error("CONTRACT_ANSWERS_INVALID: the answers file could not be read");
  }
  const inside = path.relative(await realpath(vault), file);
  const outside = inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside);
  if (!outside) {
    throw new Error("CONTRACT_ANSWERS_INVALID: keep the answers file outside the vault");
  }
  return readFile(file, "utf8");
}

async function readAnswers(vault: string, source: string): Promise<Answers> {
  return parseAnswers(await readOutsideVault(vault, source));
}

/** Setup without a terminal: questions out, answers in. Only a first or non-loosening seal goes through. */
async function scriptedSetup(vault: string, args: ContractArgs): Promise<void> {
  const answers = args.answers === undefined ? {} : await readAnswers(vault, args.answers);
  const { io, notes } = scriptedIO(answers);
  const result = await runInterview({ vault, io, nonLoosening: true, ...(args.reask ? { reask: true } : {}) });
  if (args.questions && result.state === "incomplete") {
    print({ status: "questions", questions: result.questions.map(publicQuestion), notes });
    return;
  }
  printResult(result, notes);
}

async function setup(vault: string, args: ContractArgs, deps: ContractCommandDeps): Promise<void> {
  const interactive = deps.interactive ?? (process.stdin.isTTY === true && process.env["OMS_NON_INTERACTIVE"] !== "1");
  if (deps.io === undefined && !interactive) {
    process.exitCode = 1;
    console.error("[oms] oms setup needs an interactive terminal. Run `oms setup` or `oms interview` yourself in a terminal, or let an agent ask you with `oms setup --questions` and `oms setup --answers <file>`.");
    return;
  }
  const terminal = deps.io === undefined ? terminalIO() : null;
  try {
    const owner = deps.io ?? terminal!.io;
    const resume = deps.resume;
    const resumed = resume === undefined ? null : await resumableIO({
      vault,
      root: resume.root ?? storeRoot(),
      fallback: owner,
      restart: resume.restart === true,
      ...(resume.now === undefined ? {} : { now: resume.now }),
    });
    const unreadable = resumed === null ? 0 : resumed.corrupt.length + resumed.pendingCorrupt.length;
    if (unreadable > 0) {
      console.error(`[oms] The interview log has ${unreadable} unreadable line(s); they were skipped and left in place.`);
    }
    if (resumed !== null && resumed.pending > 0) console.error(`[oms] Continuing the interview with ${resumed.pending} earlier answer(s). Run \`oms interview --restart\` to start over.`);
    const result = await runInterview({
      vault,
      io: resumed?.io ?? owner,
      ...(resume?.root === undefined ? {} : { root: resume.root }),
      ...(resume?.sealDeps === undefined ? {} : { sealDeps: resume.sealDeps }),
      ...(args.reask ? { reask: true } : {}),
    });
    for (const drift of resumed?.drift ?? []) {
      console.error(`[oms] Earlier answer to ${drift.questionId} was dropped (${drift.reason === "question-changed" ? "the question changed" : "the interview rejected it"}).`);
    }
    printResult(result);
  } finally {
    terminal?.close();
  }
}

/**
 * What a template in `templateFolder` scaffolds, read live: its keys and headings. Values
 * are not printed; the template file itself is the place to read them.
 */
async function extract(vault: string, template: string): Promise<void> {
  const selection = selectTemplate(await loadLiveTemplates(vault), { explicit: template });
  if (selection.kind !== "template") {
    process.exitCode = 1;
    print({ status: "missing", template, remediation: "No template by that name is in templateFolder. Set templateFolder in .oms/settings.json, or check the name." });
    return;
  }
  const { name, source, folder, fields, headings } = selection.template;
  print({ status: "scaffold", name, source, folder, properties: fields.map(field => field.name), headings: headings.map(heading => heading.title) });
}

/** Open gaps are the ledger doing its job; only a contradiction or an unreadable ledger needs attention, and a truncated one is a warning. */
async function gaps(vault: string): Promise<void> {
  const report = await gapsReport(vault);
  if (report.contradictions.length > 0 || report.ledger === "unreadable" || report.corruptLines.length > 0) process.exitCode = 1;
  print(report);
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
    && report.unsafePatterns.length === 0 && report.staleLocks === 0 && report.orphans === 0 && report.unexpectedControlFiles.length === 0
    && report.interviewLog.corrupt.length === 0 && report.interviewLog.pendingCorrupt.length === 0 && !report.interviewLog.unreadable
    && !lineageNeedsAttention(report.lineage);
  if (!healthy) process.exitCode = 1;
  print({
    contract: report.contract,
    findings: report.findings,
    cause: report.cause,
    recovery: report.recovery,
    unsafePatterns: report.unsafePatterns,
    staleLocks: report.staleLocks,
    orphans: report.orphans,
    unexpectedControlFiles: report.unexpectedControlFiles,
    transportFailures: report.transportFailures,
    interviewLog: report.interviewLog,
    lineage: report.lineage,
  });
}

export interface ContractCommandDeps {
  /** Scripted IO for tests; when given, the terminal check is skipped. */
  readonly io?: InterviewIO;
  readonly interactive?: boolean;
  /** `oms interview`: continue from the interview log; `restart` abandons the logged run first. */
  readonly resume?: {
    readonly restart?: boolean;
    /** Store root and clock for tests; the defaults are ~/.oms/vaults and Date.now. */
    readonly root?: string;
    readonly now?: () => number;
    readonly sealDeps?: Partial<SealDeps>;
  };
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
      throw new Error("CONTRACT_VAULT_UNRESOLVED: the vault could not be resolved. Pass --vault <path> or run: oms doctor status");
    }
    const writes = args.verb === "setup" || args.verb === "doctor" && args.fix;
    if (writes && target.source === "cwd") {
      throw new Error(`CONTRACT_ARGS_INVALID: ${args.verb === "setup" ? "setup" : "doctor contract --fix"} writes and requires --vault or an existing verified vault/bridge/env target`);
    }
    const vault = target.vault;
    if (args.verb === "setup" && (args.questions || args.answers !== undefined)) await scriptedSetup(vault, args);
    else if (args.verb === "setup") await setup(vault, args, deps);
    else if (args.verb === "extract") await extract(vault, args.template!);
    else if (args.verb === "status") {
      const status = await contractStatus(vault);
      print({ contract: status.contract, findings: status.findings, legacyTemplates: status.legacyTemplates });
    } else if (args.verb === "gaps") await gaps(vault);
    else await doctor(vault, args.fix);
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
  ENOENT: "A file disappeared while the command ran. Retry, then run: oms doctor contract",
  ELOOP: "A symlink loop was found. Run: oms doctor contract",
};

/**
 * Coded, path-free diagnostics. Messages we author (`CONTRACT_`, vault settings,
 * unsafe template source) carry field names only and pass through.
 */
export function commandDiagnostic(error: unknown): { readonly code: string; readonly remediation: string } {
  if (error instanceof VaultSettingsError) return { code: error.code, remediation: error.message };
  if (error instanceof StateDirUnsafe) {
    // The path names the store; only the kind is reported.
    return { code: error.code, remediation: `STATE_DIR_UNSAFE: the interview state beside the contract store holds an unsafe entry (${error.kind}); it was left untouched. Inspect ~/.oms/vaults, remove the entry yourself, then retry.` };
  }
  if (error instanceof Error && /^(CONTRACT_[A-Z_]+|INTERVIEW_[A-Z_]+|TEMPLATE_SOURCE_UNSAFE):/.test(error.message)) {
    return { code: error.message.split(":", 1)[0]!, remediation: error.message };
  }
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof errno === "string" && /^E[A-Z]+$/.test(errno)) {
    return { code: "CONTRACT_FS_ERROR", remediation: `${errno}: ${FS_REMEDIATION[errno] ?? "A filesystem operation failed. Run: oms doctor contract"}` };
  }
  return { code: "CONTRACT_COMMAND_FAILED", remediation: "The contract command failed. Run: oms doctor contract" };
}
