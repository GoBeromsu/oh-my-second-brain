import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { InterviewAborted, runInterview, type InterviewIO, type InterviewTarget, type Question } from "../kernel/contract/interview.js";
import { contractStatus } from "../kernel/contract/status.js";
import { recordSeen, reissue } from "../kernel/contract/store.js";
import { readVaultId, VAULT_ID_PATH } from "../kernel/contract/vault-id.js";
import { resolveEffectiveVault } from "../kernel/link/link.js";
import { atomicWrite } from "../kernel/templates/file-lock.js";

export function contractUsage(): string {
  return `Usage: oms contract <interview|status|reissue-id> [options]

  interview --template <path> [--vault <path>]
            Interview one template and seal its rules. <path> is relative to the vault.
  interview --common [--vault <path>]
            Interview and seal the common rules every template must keep.
  status [--vault <path>]
            Show the contract posture. Hidden values are never printed.
  reissue-id [--vault <path>]
            Give this vault a new id (use after copying a vault) and copy its sealed rules.

The interview is interactive and needs a terminal; it is never run by an agent.`;
}

interface ContractArgs {
  readonly verb: string;
  readonly vault?: string;
  readonly template?: string;
  readonly common: boolean;
}

function parse(argv: readonly string[]): ContractArgs {
  const [verb, ...rest] = argv;
  if (verb === undefined) throw new Error("CONTRACT_ARGS_INVALID: missing subcommand (interview, status, or reissue-id)");
  if (!["interview", "status", "reissue-id"].includes(verb)) throw new Error(`CONTRACT_ARGS_INVALID: unknown subcommand ${verb}`);
  let vault: string | undefined;
  let template: string | undefined;
  let common = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === "--common" && verb === "interview") {
      if (common) throw new Error("CONTRACT_ARGS_INVALID: duplicate flag --common");
      common = true;
      continue;
    }
    if (token !== "--vault" && !(token === "--template" && verb === "interview")) {
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
  if (verb === "interview" && (template === undefined) === !common) {
    throw new Error("CONTRACT_ARGS_INVALID: interview needs exactly one of --template <path> or --common");
  }
  return { verb, common, ...(vault === undefined ? {} : { vault }), ...(template === undefined ? {} : { template }) };
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function templateTarget(vault: string, template: string): InterviewTarget {
  const relative = path.isAbsolute(template) ? path.relative(vault, template) : path.normalize(template);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`CONTRACT_ARGS_INVALID: --template must name a file inside the vault (${template})`);
  }
  return { kind: "template", sourcePath: relative.split(path.sep).join("/") };
}

function describe(question: Question): string {
  if (question.kind === "choice") {
    const options = question.options.map((option, index) => `  ${index + 1}) ${option}`).join("\n");
    return `${question.prompt}\n${options}\n> `;
  }
  if (question.kind === "confirm") return `${question.prompt} [y/n] `;
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

async function interview(vault: string, args: ContractArgs, deps: ContractCommandDeps): Promise<void> {
  const interactive = deps.interactive ?? (process.stdin.isTTY === true && process.env["OMS_NON_INTERACTIVE"] !== "1");
  if (deps.io === undefined && !interactive) {
    process.exitCode = 1;
    console.error("[oms] contract interview needs an interactive terminal. Run it yourself in a terminal; it is never run by an agent or a script.");
    return;
  }
  const target: InterviewTarget = args.common ? { kind: "common" } : templateTarget(vault, args.template!);
  const terminal = deps.io === undefined ? terminalIO() : null;
  try {
    const result = await runInterview({ vault, target, io: deps.io ?? terminal!.io });
    if (result.state !== "sealed") process.exitCode = 1;
    if (result.state === "sealed") {
      print({
        status: "sealed",
        vault,
        vaultIdCreated: result.vaultIdCreated,
        ...(result.publicTemplate === null ? {} : { template: { id: result.publicTemplate.id, name: result.publicTemplate.name, sealId: result.publicTemplate.sealId } }),
        ...(result.publicCommon === null ? {} : { common: { sealId: result.publicCommon.sealId } }),
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

async function reissueId(vault: string): Promise<void> {
  const current = await readVaultId(vault);
  if (current.state !== "ok") {
    throw new Error(`CONTRACT_VAULT_ID_UNAVAILABLE: ${current.state === "absent" ? "this vault has no .oms/vault-id; seal a contract first" : `.oms/vault-id is invalid (${current.reason})`}`);
  }
  const next = randomUUID();
  const copied = await reissue(current.id, next);
  if (!copied.ok) throw new Error(`CONTRACT_REISSUE_FAILED: ${copied.reason}`);
  await atomicWrite(path.join(vault, VAULT_ID_PATH), `${next}\n`);
  const seen = await recordSeen(next, await realpath(vault));
  if (!seen.ok) throw new Error(`CONTRACT_REISSUE_FAILED: ${seen.reason}`);
  print({ status: "reissued", vault, previousVaultId: current.id, vaultId: next });
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
    const target = args.vault === undefined
      ? await resolveEffectiveVault(process.cwd(), process.env)
      : { vault: path.resolve(args.vault), source: "explicit" as const };
    if (args.verb !== "status" && target.source === "cwd") {
      throw new Error(`CONTRACT_ARGS_INVALID: contract ${args.verb} writes to the vault and requires --vault or an existing verified vault/bridge/env target`);
    }
    const vault = target.vault;
    if (args.verb === "interview") await interview(vault, args, deps);
    else if (args.verb === "status") print({ vault, contract: await contractStatus(vault) });
    else await reissueId(vault);
  } catch (error: unknown) {
    process.exitCode = 1;
    print({ status: "rejected", diagnostics: [{ code: error instanceof Error ? error.message.split(":", 1)[0] : "CONTRACT_COMMAND_FAILED", remediation: error instanceof Error ? error.message : String(error) }] });
  }
}
