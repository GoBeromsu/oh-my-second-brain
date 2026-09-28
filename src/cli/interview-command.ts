import { runContractCommand, type ContractCommandDeps } from "./contract-command.js";

/**
 * `oms interview`: the owner's interactive vault interview in a terminal. It is the
 * full-authority seal (it may loosen a sealed contract), so it needs a real terminal
 * and refuses OMS_NON_INTERACTIVE=1. Agents use `oms setup --questions/--answers`.
 * Each answer is logged beside the contract store, so an interrupted interview
 * continues where it stopped; `--restart` abandons the logged run and starts over.
 */

export function interviewUsage(): string {
  return `Usage: oms interview [--reask] [--restart] [--vault <path>]

Ask the vault owner about folders, properties and templates in the terminal, then seal
the contract. It needs an interactive terminal and refuses OMS_NON_INTERACTIVE=1.
--reask asks again about items declined at an earlier seal.
An interrupted interview continues from its logged answers; --restart starts over.
An agent asks the same questions with \`oms setup --questions\` and \`oms setup --answers <file>\`.`;
}

interface InterviewArgs {
  readonly restart: boolean;
  /** The arguments passed on to `oms setup`: `--reask` and `--vault <path>`. */
  readonly rest: readonly string[];
}

/** Parses the flags in one pass, so a flag's value is never read as a flag of its own. */
function parseArgs(argv: readonly string[]): InterviewArgs | string {
  let vault = false;
  let reask = false;
  let restart = false;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--reask") {
      if (reask) return "interview: duplicate flag --reask";
      reask = true;
      rest.push(token);
    } else if (token === "--restart") {
      if (restart) return "interview: duplicate flag --restart";
      restart = true;
    } else if (token === "--vault") {
      if (vault) return "interview: duplicate flag --vault";
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) return "interview: --vault requires a value";
      vault = true;
      rest.push(token, value);
    } else {
      return `interview: unknown argument ${token}`;
    }
  }
  return { restart, rest };
}

export async function runInterviewCommand(argv: readonly string[], deps: ContractCommandDeps = {}): Promise<void> {
  process.exitCode = 0;
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(interviewUsage());
    return;
  }
  const args = parseArgs(argv);
  if (typeof args === "string") {
    process.exitCode = 1;
    console.error(`[oms] ${args}`);
    return;
  }
  const interactive = deps.interactive ?? (process.stdin.isTTY === true && process.env["OMS_NON_INTERACTIVE"] !== "1");
  if (deps.io === undefined && !interactive) {
    process.exitCode = 1;
    console.error("[oms] oms interview needs an interactive terminal (and OMS_NON_INTERACTIVE unset). An agent asks the owner with `oms setup --questions` and `oms setup --answers <file>`.");
    return;
  }
  await runContractCommand(["setup", ...args.rest], { ...deps, resume: { ...deps.resume, restart: args.restart } });
}
