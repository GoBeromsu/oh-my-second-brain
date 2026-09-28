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
  "--install-claude": "Use `oms setup host install`.",
  "--runtime": "Use `oms setup host install --runtime <runtime>`.",
  "--agent-vault": "Use `oms setup host install --agent-vault <path>`.",
  "--execute": "Use `oms setup host install --execute`.",
  "--models-default": "Use `oms setup model install --default`, then `oms setup model select --default`.",
  "--models-descriptor": "Use `oms setup model install --descriptor <path>`, then `oms setup model select --descriptor <path>`.",
  "--models-no-default": "Use `oms setup model waive --yes`.",
  "--embedding-default": "Use `oms setup model install --default`, then `oms setup model select --default`.",
  "--embedding-no-default": "Use `oms setup model waive --yes`.",
  "--embedding-descriptor": "Use `oms setup model install --descriptor <path>`, then `oms setup model select --descriptor <path>`.",
  "--template-folder": "Templates are found by the setup interview.",
};

export function setupUsage(): string {
  return `Usage: oms setup [--reask] [--vault <path>]
       oms setup --questions [--reask] [--vault <path>]
       oms setup --answers <file|-> [--reask] [--vault <path>]
       oms setup extract --template <path> [--vault <path>]
       oms setup status [--vault <path>]
       oms setup host <install|remove|sync|status> [options]
       oms setup model <install|select|waive|status> [options]
       oms setup package <check|update> [options]
       oms setup bridge <add|remove|status> [options]

Interview the whole vault (folders, properties, templates) and seal the contract.
Setup writes only .oms/settings.json inside the vault; the sealed contract lives outside it.
Run it again at any time to re-seal. In a terminal it is interactive and has full authority,
including loosening a sealed contract (\`oms interview\` is the same terminal interview).

--questions prints the interview questions as JSON and seals nothing. --answers runs the
same interview from a JSON object of answers by question id (- reads stdin) and seals.
This is how an agent asks the owner each question (the setup skill). It seals a first
contract or a stricter one only; loosening is left to \`oms setup\` in a terminal.

extract shows a template source and its hash; status shows the contract posture and
template drift. host, model, package and bridge configure what surrounds the vault.`;
}

/** Top-level `oms setup`: the seal, plus the leaves that configure what surrounds the vault. */
export async function runSetup(argv: readonly string[], deps: ContractCommandDeps = {}): Promise<void> {
  const [leaf, ...rest] = argv;
  if (leaf === "host") {
    const { runHostCommand } = await import("./host-commands.js");
    await runHostCommand(rest);
    return;
  }
  if (leaf === "model") {
    const { runModelCommand } = await import("./model-command.js");
    await runModelCommand(rest);
    return;
  }
  if (leaf === "package") {
    const { runPackageCommand } = await import("./package-command.js");
    await runPackageCommand(rest);
    return;
  }
  if (leaf === "bridge") {
    const { runBridgeCommand } = await import("./link-command.js");
    await runBridgeCommand(rest);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.exitCode = 0;
    console.log(setupUsage());
    return;
  }
  if (leaf === "extract" || leaf === "status") {
    await runContractCommand([leaf, ...rest], deps);
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
