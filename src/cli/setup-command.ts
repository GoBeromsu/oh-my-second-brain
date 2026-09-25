import { runContractCommand, type ContractCommandDeps } from "./contract-command.js";

/**
 * Flags of the retired approval-token setup. `oms setup` is now the
 * interactive seal, so each one is refused with the command that owns it.
 */
const RETIRED_SETUP_FLAGS: Readonly<Record<string, string>> = {
  "--dry-run": "setup is an interactive interview; it has no dry-run.",
  "--yes": "setup is an interactive interview; it takes no approval flags.",
  "--approval-token": "setup is an interactive interview; it takes no approval flags.",
  "--approved-digest": "setup is an interactive interview; it takes no approval flags.",
  "--install-claude": "Use `oms host install`.",
  "--runtime": "Use `oms host install --runtime <runtime>`.",
  "--agent-vault": "Use `oms host install --agent-vault <path>`.",
  "--execute": "Use `oms host install --execute`.",
  "--models-default": "Use `oms model install --default`, then `oms model select --default`.",
  "--models-descriptor": "Use `oms model install --descriptor <path>`, then `oms model select --descriptor <path>`.",
  "--models-no-default": "Use `oms model waive --yes`.",
  "--embedding-default": "Use `oms model install --default`, then `oms model select --default`.",
  "--embedding-no-default": "Use `oms model waive --yes`.",
  "--embedding-descriptor": "Use `oms model install --descriptor <path>`, then `oms model select --descriptor <path>`.",
  "--template-folder": "Templates are found by the setup interview.",
};

export function setupUsage(): string {
  return `Usage: oms setup [--reask] [--vault <path>]
       oms setup --questions [--reask] [--vault <path>]
       oms setup --answers <file|-> [--reask] [--vault <path>]

Interview the whole vault (folders, properties, templates) and seal the contract.
Setup writes only .oms/settings.json inside the vault; the sealed contract lives outside it.
Run it again at any time to re-seal. In a terminal it is interactive and has full authority,
including loosening a sealed contract.

--questions prints the interview questions as JSON and seals nothing. --answers runs the
same interview from a JSON object of answers by question id (- reads stdin) and seals.
This is how an agent asks the owner each question (the setup skill). It seals a first
contract or a stricter one only; loosening is left to \`oms setup\` in a terminal.
Same as \`oms contract setup\`.`;
}

/** Top-level `oms setup`: the interactive seal (alias of `oms contract setup`). */
export async function runSetup(argv: readonly string[], deps: ContractCommandDeps = {}): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.exitCode = 0;
    console.log(setupUsage());
    return;
  }
  const retired = argv.find((token) => Object.hasOwn(RETIRED_SETUP_FLAGS, token));
  if (retired !== undefined) {
    process.exitCode = 1;
    console.error(`[oms] setup option ${retired} was removed. ${RETIRED_SETUP_FLAGS[retired]}`);
    return;
  }
  await runContractCommand(["setup", ...argv], deps);
}
