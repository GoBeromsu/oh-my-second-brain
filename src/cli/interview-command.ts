import { runContractCommand, type ContractCommandDeps } from "./contract-command.js";

/**
 * `oms interview`: the owner's interactive vault interview in a terminal. It is the
 * full-authority seal (it may loosen a sealed contract), so it needs a real terminal
 * and refuses OMS_NON_INTERACTIVE=1. Agents use `oms setup --questions/--answers`.
 */

export function interviewUsage(): string {
  return `Usage: oms interview [--reask] [--vault <path>]

Ask the vault owner about folders, properties and templates in the terminal, then seal
the contract. It needs an interactive terminal and refuses OMS_NON_INTERACTIVE=1.
--reask asks again about items declined at an earlier seal.
An agent asks the same questions with \`oms setup --questions\` and \`oms setup --answers <file>\`.`;
}

function checkArgs(argv: readonly string[]): string | undefined {
  let vault = false;
  let reask = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--reask") {
      if (reask) return "interview: duplicate flag --reask";
      reask = true;
    } else if (token === "--vault") {
      if (vault) return "interview: duplicate flag --vault";
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) return "interview: --vault requires a value";
      vault = true;
    } else {
      return `interview: unknown argument ${token}`;
    }
  }
  return undefined;
}

export async function runInterviewCommand(argv: readonly string[], deps: ContractCommandDeps = {}): Promise<void> {
  process.exitCode = 0;
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(interviewUsage());
    return;
  }
  const invalid = checkArgs(argv);
  if (invalid !== undefined) {
    process.exitCode = 1;
    console.error(`[oms] ${invalid}`);
    return;
  }
  const interactive = deps.interactive ?? (process.stdin.isTTY === true && process.env["OMS_NON_INTERACTIVE"] !== "1");
  if (deps.io === undefined && !interactive) {
    process.exitCode = 1;
    console.error("[oms] oms interview needs an interactive terminal (and OMS_NON_INTERACTIVE unset). An agent asks the owner with `oms setup --questions` and `oms setup --answers <file>`.");
    return;
  }
  await runContractCommand(["setup", ...argv], deps);
}
